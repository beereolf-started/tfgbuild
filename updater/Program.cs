// Окно обновлялки: папка игры, кнопка «Обновить», полоса и журнал. Без излишеств.
using System;
using System.Collections.Generic;
using System.Drawing;
using System.IO;
using System.Linq;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;

namespace TfgUpdater
{
    public static class Program
    {
        public const string Version = "1.0";

        [STAThread]
        static int Main(string[] args)
        {
            // без окна: TfgUpdater.exe --auto "<папка игры>" - обновить и выйти (журнал - .tfgbuild/log.txt)
            if (args.Length == 2 && args[0] == "--auto") return Auto(args[1]);
            // --plan "<папка игры>": только показать, что бы сделала (ничего не меняет), журнал - в stdout-файл рядом с программой
            if (args.Length == 2 && args[0] == "--plan") return PlanOnly(args[1]);
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            Application.Run(new MainForm());
            return 0;
        }

        sealed class FileReport : IReport
        {
            readonly string file;
            public FileReport(string file) { this.file = file; }
            public void Log(string text) { lock (this) File.AppendAllText(file, DateTime.Now.ToString("HH:mm:ss ") + text + Environment.NewLine, Encoding.UTF8); }
            public void Progress(long done, long total, string what) { }
        }

        static int PlanOnly(string game)
        {
            var r = new FileReport(Path.Combine(Path.GetTempPath(), "tfgupdater-plan.txt"));
            try
            {
                var m = Updater.FetchManifest().GetAwaiter().GetResult();
                var u = new Updater(game, r);
                var plan = u.MakePlan(m, u.LoadState());
                r.Log("Сборка " + m.Version + ", Forge у игры: " + (u.FindForge() ?? "не найден"));
                r.Log("скачать " + plan.Download.Count + ", убрать " + plan.Remove.Count + ", сохранить копию " + plan.Backup.Count + ", без изменений " + plan.Same.Count + ", оставлены правки " + plan.KeptUserChanges);
                foreach (var f in plan.Download.Take(30)) r.Log("  скачать " + f.Path);
                foreach (var f in plan.Remove.Take(30)) r.Log("  убрать  " + f);
                foreach (var f in plan.Backup.Take(30)) r.Log("  копия   " + f);
                return 0;
            }
            catch (Exception ex)
            {
                r.Log("Ошибка: " + ex);
                return 1;
            }
        }

        static int Auto(string game)
        {
            Directory.CreateDirectory(Path.Combine(game, ".tfgbuild"));
            var r = new FileReport(Path.Combine(game, ".tfgbuild", "log.txt"));
            try
            {
                var m = Updater.FetchManifest().GetAwaiter().GetResult();
                new Updater(game, r).Run(m, CancellationToken.None).GetAwaiter().GetResult();
                return 0;
            }
            catch (Exception ex)
            {
                r.Log("Ошибка: " + ex);
                return 1;
            }
        }
    }

    public sealed class MainForm : Form, IReport
    {
        static readonly string SettingsFile = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "TfgUpdater", "game.txt");

        readonly TextBox path = new TextBox { Anchor = AnchorStyles.Left | AnchorStyles.Right | AnchorStyles.Top };
        readonly Button browse = new Button { Text = "Папка...", Anchor = AnchorStyles.Right | AnchorStyles.Top, Width = 80 };
        readonly Label status = new Label { AutoSize = false, Anchor = AnchorStyles.Left | AnchorStyles.Right | AnchorStyles.Top };
        readonly ProgressBar bar = new ProgressBar { Anchor = AnchorStyles.Left | AnchorStyles.Right | AnchorStyles.Top, Maximum = 1000 };
        readonly TextBox log = new TextBox { Multiline = true, ReadOnly = true, ScrollBars = ScrollBars.Vertical, Anchor = AnchorStyles.Left | AnchorStyles.Right | AnchorStyles.Top | AnchorStyles.Bottom };
        /// <summary>Одна кнопка: пока обновляется - ждать, готово - «Играть», сбой - «Повторить».</summary>
        readonly Button go = new Button { Text = "Обновление...", Enabled = false, Anchor = AnchorStyles.Right | AnchorStyles.Bottom, Width = 140, Height = 34 };
        static readonly string LauncherFile = Path.Combine(Path.GetDirectoryName(SettingsFile), "launcher.txt");
        CancellationTokenSource stop;
        bool ready;

        public MainForm()
        {
            Text = "TerraFirmaGreg";
            ClientSize = new Size(620, 400);
            MinimumSize = new Size(480, 300);
            StartPosition = FormStartPosition.CenterScreen;
            Font = new Font("Segoe UI", 9f);

            var label = new Label { Text = "Папка игры (где лежат mods и config):", AutoSize = true, Location = new Point(10, 10) };
            path.SetBounds(10, 30, 510, 23);
            browse.SetBounds(530, 29, 80, 25);
            status.SetBounds(10, 62, 600, 20);
            bar.SetBounds(10, 85, 600, 16);
            log.SetBounds(10, 110, 600, 238);
            go.SetBounds(470, 356, 140, 34);
            go.Font = new Font("Segoe UI", 10f, FontStyle.Bold);
            Controls.AddRange(new Control[] { label, path, browse, status, bar, log, go });
            AcceptButton = go;

            browse.Click += async (s, e) => { if (Browse()) await DoUpdate(); };
            go.Click += async (s, e) => { if (ready) Play(); else await DoUpdate(); };
            // скачал и играй: папку находим сами и сразу обновляем
            Shown += async (s, e) =>
            {
                path.Text = LoadGame() ?? Detect() ?? "";
                await DoUpdate();
            };
            FormClosing += (s, e) => { if (stop != null) stop.Cancel(); };
        }

        // ─── папка игры ─────────────────────────────────────────────────────

        static string LoadGame()
        {
            try { return File.Exists(SettingsFile) ? File.ReadAllText(SettingsFile, Encoding.UTF8).Trim() : null; }
            catch (Exception) { return null; }
        }

        static void SaveGame(string dir)
        {
            Directory.CreateDirectory(Path.GetDirectoryName(SettingsFile));
            File.WriteAllText(SettingsFile, dir, new UTF8Encoding(false));
        }

        /// <summary>Где обычно лежит игра: TLauncher, обычный лаунчер, сборки Prism. Берём ту, где уже есть моды.</summary>
        static string Detect()
        {
            string ad = Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData);
            var places = new List<string> { Path.Combine(ad, ".tlauncher", "legacy", "Minecraft", "game"), Path.Combine(ad, ".minecraft") };
            string prism = Path.Combine(ad, "PrismLauncher", "instances");
            if (Directory.Exists(prism))
                foreach (string inst in Directory.GetDirectories(prism)) places.Add(Path.Combine(inst, ".minecraft"));
            // игра с модами; нет такой - любая из известных папок (свежая установка)
            return places.FirstOrDefault(p => Directory.Exists(Path.Combine(p, "mods"))) ?? places.FirstOrDefault(Directory.Exists);
        }

        bool Browse()
        {
            using (var d = new FolderBrowserDialog { Description = "Папка игры: в ней должны быть mods, config, saves", SelectedPath = path.Text })
            {
                if (d.ShowDialog(this) != DialogResult.OK) return false;
                path.Text = d.SelectedPath;
                return true;
            }
        }

        // ─── обновление ─────────────────────────────────────────────────────

        async Task DoUpdate()
        {
            string dir = path.Text.Trim();
            if (dir.Length == 0 || !Directory.Exists(dir))
            {
                status.Text = "Не нашёл игру. Нажмите «Папка...» и укажите папку игры.";
                go.Text = "Повторить";
                go.Enabled = true;
                return;
            }
            ready = false;
            go.Text = "Обновление...";
            go.Enabled = browse.Enabled = path.Enabled = false;
            stop = new CancellationTokenSource();
            try
            {
                SaveGame(dir);
                status.Text = "Проверка сборки...";
                var m = await Updater.FetchManifest();
                var u = new Updater(dir, this);
                string forge = u.FindForge();
                if (forge == null && u.IsPrism()) Log("В Prism добавьте к этой сборке Forge " + (m.Forge ?? "1.20.1") + " (Изменить → Версия → Установить Forge).");
                else if (forge == null && m.Forge != null)
                {
                    // нет Forge - ставим сами официальным установщиком
                    try { await Task.Run(() => u.InstallForge(m.Forge, stop.Token)); }
                    catch (Exception ex) when (!(ex is OperationCanceledException)) { Log("Forge не встал: " + ex.Message + ". Поставьте Forge " + m.Forge + " в своём лаунчере."); }
                }
                else if (m.Forge != null && forge != m.Forge) Log("У вас Forge " + forge + ", сборка сделана на " + m.Forge + ". Обычно это не мешает; при сбоях поставьте " + m.Forge + ".");
                if (m.UpdaterVersion != null && string.CompareOrdinal(m.UpdaterVersion, Program.Version) > 0)
                    Log("Есть новая версия этой программы: " + m.UpdaterUrl);
                await Task.Run(() => u.Run(m, stop.Token));
                status.Text = "Сборка " + m.Version + " готова. Можно играть.";
                bar.Value = bar.Maximum;
                ready = true;
                go.Text = "Играть";
            }
            catch (OperationCanceledException)
            {
                Log("Остановлено.");
                go.Text = "Повторить";
            }
            catch (System.Net.Http.HttpRequestException ex)
            {
                Log("Нет связи с GitHub: " + ex.Message);
                status.Text = "Нет интернета или GitHub недоступен.";
                go.Text = "Повторить";
            }
            catch (Exception ex)
            {
                Log("Ошибка: " + ex.Message);
                status.Text = "Обновление не закончено.";
                go.Text = "Повторить";
            }
            finally
            {
                go.Enabled = browse.Enabled = path.Enabled = true;
                go.Focus();
            }
        }

        // ─── запуск лаунчера ────────────────────────────────────────────────

        /// <summary>Открыть лаунчер игрока и закрыться. Лаунчер ищем рядом с игрой и в обычных местах; не нашли - спросим один раз.</summary>
        void Play()
        {
            string exe = FindLauncher(path.Text.Trim(), out string args);
            if (exe == null)
            {
                using (var d = new OpenFileDialog { Title = "Где ваш лаунчер Minecraft?", Filter = "Программа (*.exe)|*.exe" })
                {
                    if (d.ShowDialog(this) != DialogResult.OK) return;
                    exe = d.FileName;
                    args = "";
                    File.WriteAllText(LauncherFile, exe, new UTF8Encoding(false));
                }
            }
            try
            {
                System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo(exe, args) { WorkingDirectory = Path.GetDirectoryName(exe), UseShellExecute = true });
                Close();
            }
            catch (Exception ex)
            {
                Log("Не удалось открыть лаунчер: " + ex.Message);
                try { File.Delete(LauncherFile); } catch (Exception) { }
            }
        }

        static string FindLauncher(string game, out string args)
        {
            args = "";
            try { if (File.Exists(LauncherFile)) { string saved = File.ReadAllText(LauncherFile, Encoding.UTF8).Trim(); if (File.Exists(saved)) return saved; } }
            catch (Exception) { }
            string parent = Directory.GetParent(game)?.FullName ?? game;
            // сборка Prism: prismlauncher -l <имя сборки>
            string prismExe = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Programs", "PrismLauncher", "prismlauncher.exe");
            if (game.IndexOf(Path.Combine("PrismLauncher", "instances"), StringComparison.OrdinalIgnoreCase) >= 0 && File.Exists(prismExe))
            {
                args = "-l \"" + Path.GetFileName(parent) + "\"";
                return prismExe;
            }
            string ad = Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData);
            string pf86 = Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86);
            string[] places =
            {
                Path.Combine(parent, "LL.exe"), Path.Combine(parent, "TLauncher.exe"), Path.Combine(game, "TLauncher.exe"),
                Path.Combine(ad, ".tlauncher", "legacy", "Minecraft", "LL.exe"), Path.Combine(ad, ".minecraft", "TLauncher.exe"),
                Path.Combine(pf86, "Minecraft Launcher", "MinecraftLauncher.exe"), prismExe
            };
            return places.FirstOrDefault(File.Exists);
        }

        // ─── IReport (из любого потока) ─────────────────────────────────────

        public void Log(string text)
        {
            if (InvokeRequired) { BeginInvoke((Action)(() => Log(text))); return; }
            log.AppendText(DateTime.Now.ToString("HH:mm:ss ") + text + Environment.NewLine);
        }

        long lastTick;

        public void Progress(long done, long total, string what)
        {
            long now = Environment.TickCount;
            if (done < total && now - Interlocked.Read(ref lastTick) < 100) return;      // не чаще 10 раз в секунду
            Interlocked.Exchange(ref lastTick, now);
            if (InvokeRequired) { BeginInvoke((Action)(() => Progress(done, total, what))); return; }
            bar.Value = (int)Math.Min(bar.Maximum, total <= 0 ? 0 : done * bar.Maximum / total);
            status.Text = what;
        }
    }
}
