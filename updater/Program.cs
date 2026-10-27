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
        readonly Button go = new Button { Text = "Обновление...", Enabled = false, Anchor = AnchorStyles.Right | AnchorStyles.Bottom, Width = 220, Height = 34 };
        static readonly string LauncherFile = Path.Combine(Path.GetDirectoryName(SettingsFile), "launcher.txt");
        CancellationTokenSource stop;
        bool ready, updating, skip;

        public MainForm()
        {
            Text = "Хроники Отмели";
            ClientSize = new Size(620, 400);
            MinimumSize = new Size(480, 300);
            StartPosition = FormStartPosition.CenterScreen;
            Font = new Font("Segoe UI", 9f);
            try { Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath); } catch (Exception) { }

            var label = new Label { Text = "Папка игры (где лежат mods и config):", AutoSize = true, Location = new Point(10, 10) };
            path.SetBounds(10, 30, 510, 23);
            browse.SetBounds(530, 29, 80, 25);
            status.SetBounds(10, 62, 600, 20);
            bar.SetBounds(10, 85, 600, 16);
            log.SetBounds(10, 110, 600, 238);
            go.SetBounds(390, 356, 220, 34);
            go.Font = new Font("Segoe UI", 10f, FontStyle.Bold);
            Controls.AddRange(new Control[] { label, path, browse, status, bar, log, go });
            AcceptButton = go;

            browse.Click += async (s, e) => { if (Browse()) await DoUpdate(); };
            go.Click += async (s, e) =>
            {
                if (ready) Play();
                else if (updating) { skip = true; stop?.Cancel(); Play(); }        // проверку можно пропустить - сразу в игру
                else await DoUpdate();
            };
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
            ready = skip = false;
            updating = true;
            go.Text = "Пропустить и играть";                              // проверку можно не ждать
            browse.Enabled = path.Enabled = false;
            go.Enabled = true;
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
                updating = false;
                if (skip) return;                                                    // уже ушли в игру
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
                updating = false;
                if (!IsDisposed)
                {
                    go.Enabled = browse.Enabled = path.Enabled = true;
                    go.Focus();
                }
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
                var direct = DirectStart(path.Text.Trim(), exe);
                var psi = direct ?? new System.Diagnostics.ProcessStartInfo(exe, args) { WorkingDirectory = Path.GetDirectoryName(exe), UseShellExecute = true };
                System.Diagnostics.Process.Start(psi);
                if (direct == null) { Close(); return; }
                // окно лаунчера не показываем, пока он готовит игру; он сам закроется, когда игра стартует
                Hide();
                var t = new Thread(() => { HideLauncherWindows(TimeSpan.FromSeconds(90)); BeginInvoke((Action)Close); }) { IsBackground = true };
                t.Start();
            }
            catch (Exception ex)
            {
                Log("Не удалось открыть лаунчер: " + ex.Message);
                try { File.Delete(LauncherFile); } catch (Exception) { }
            }
        }

        /// <summary>
        /// Legacy Launcher / TLauncher: сразу его функция запуска игры - ядро лаунчера его же Java и его же параметрами
        /// (stubLauncher.args + tl.args, как это делает LL.exe) и сверху --version (версия с Forge 1.20.1) --launch
        /// (запустить игру сразу). Не вышло собрать - null: просто открываем лаунчер.
        /// </summary>
        static System.Diagnostics.ProcessStartInfo DirectStart(string game, string launcherExe)
        {
            try
            {
                string dir = Path.GetDirectoryName(launcherExe);
                string java = Path.Combine(dir, "jre", "x64", "bin", "javaw.exe");
                string boot = Path.Combine(dir, "launcher", "bootstrap.jar");
                string version = ForgeVersionName(game, dir);
                if (!File.Exists(java) || !File.Exists(boot) || version == null) return null;
                // бутстрап дописывает к параметрам tl.args из рабочей папки - тогда ядро получает служебные параметры
                // бутстрапа и падает; запускаем из пустой папки, все пути - полные
                string work = Path.Combine(Path.GetTempPath(), "tfgupdater-launch");
                Directory.CreateDirectory(work);
                // свои настройки лаунчера на этот запуск (копия его настроек): версия с Forge, сразу запуск, после
                // старта игры лаунчер закрывается. Настоящие настройки игрока не трогаем
                string settings = Path.Combine(work, "tl.properties");
                var props = File.Exists(Path.Combine(dir, "tl.properties"))
                    ? File.ReadAllLines(Path.Combine(dir, "tl.properties"), Encoding.UTF8).ToList() : new List<string>();
                foreach (var kv in new Dictionary<string, string> { { "login.version", version }, { "login.auto", "true" }, { "minecraft.onlaunch", "exit" } })
                {
                    int i = props.FindIndex(l => l.StartsWith(kv.Key + "=", StringComparison.Ordinal));
                    if (i >= 0) props[i] = kv.Key + "=" + kv.Value; else props.Add(kv.Key + "=" + kv.Value);
                }
                File.WriteAllLines(settings, props, new UTF8Encoding(false));
                var parts = new List<string>
                {
                    "-Dtlauncher.bootstrap.restartExec=" + launcherExe, "-Xmx64M", "-jar", boot,
                    "--packageMode", "windows", "--targetJar", Path.Combine(dir, "launcher", "launcher.jar"),
                    "--targetLibFolder", Path.Combine(dir, "launcher", "libraries"),
                    "--", "--settings", settings, "--version", version, "--launch"
                };
                string line = string.Join(" ", parts.Select(Quote));
                return new System.Diagnostics.ProcessStartInfo(java, line) { WorkingDirectory = work, UseShellExecute = false };
            }
            catch (Exception)
            {
                return null;
            }
        }

        [System.Runtime.InteropServices.DllImport("user32.dll")] static extern bool EnumWindows(EnumProc f, IntPtr p);
        [System.Runtime.InteropServices.DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
        [System.Runtime.InteropServices.DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
        [System.Runtime.InteropServices.DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int cmd);
        delegate bool EnumProc(IntPtr h, IntPtr p);

        /// <summary>Процессы Legacy Launcher (его бутстрап и ядро) - по командной строке.</summary>
        static HashSet<uint> LauncherPids()
        {
            var pids = new HashSet<uint>();
            using (var q = new System.Management.ManagementObjectSearcher("SELECT ProcessId, CommandLine FROM Win32_Process WHERE Name='javaw.exe' OR Name='java.exe'"))
                foreach (System.Management.ManagementObject o in q.Get())
                {
                    string cmd = o["CommandLine"] as string ?? "";
                    // только сам лаунчер; окно игры (у неё --gameDir) не трогаем ни в коем случае
                    bool launcher = cmd.Contains(@"launcher\bootstrap.jar") || cmd.Contains(@"launcher\launcher.jar") || cmd.Contains("launcher/launcher.jar");
                    if (launcher && !cmd.Contains("--gameDir")) pids.Add((uint)o["ProcessId"]);
                }
            return pids;
        }

        /// <summary>
        /// Прятать окна лаунчера, пока он не закроется сам (запустил игру). Не закрылся за limit - вернуть окна:
        /// значит, он чего-то ждёт от игрока (вход, ошибка) - пусть будет видно.
        /// </summary>
        static void HideLauncherWindows(TimeSpan limit)
        {
            var hidden = new List<IntPtr>();
            var until = DateTime.UtcNow + limit;
            var pids = new HashSet<uint>();
            bool seen = false;
            for (int tick = 0; DateTime.UtcNow < until; tick++)
            {
                if (tick % 7 == 0)
                {
                    try { pids = LauncherPids(); } catch (Exception) { }
                    if (pids.Count > 0) seen = true;
                    else if (seen) return;                                         // лаунчер закрылся - игра запущена
                }
                EnumWindows((h, p) =>
                {
                    GetWindowThreadProcessId(h, out uint pid);
                    if (pids.Contains(pid) && IsWindowVisible(h)) { ShowWindow(h, 0); hidden.Add(h); }
                    return true;
                }, IntPtr.Zero);
                Thread.Sleep(150);
            }
            foreach (var h in hidden) ShowWindow(h, 5);                            // не дождались - показать
        }

        static string Quote(string a)
        {
            return a.IndexOfAny(new[] { ' ', '"' }) < 0 ? a : "\"" + a.Replace("\"", "\\\"") + "\"";
        }

        /// <summary>Имя версии с Forge 1.20.1 в папке versions (у игры или у лаунчера): так её зовёт лаунчер.</summary>
        static string ForgeVersionName(string game, string launcherDir)
        {
            foreach (string dir in new[] { Path.Combine(game, "versions"), Path.Combine(launcherDir, "versions") })
            {
                if (!Directory.Exists(dir)) continue;
                foreach (string v in Directory.GetDirectories(dir))
                {
                    string json = Path.Combine(v, Path.GetFileName(v) + ".json");
                    if (File.Exists(json) && File.ReadAllText(json).Contains("net.minecraftforge:forge:1.20.1-")) return Path.GetFileName(v);
                }
            }
            return null;
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
