// Обновлялка сборки TerraFirmaGreg: приводит папку игры к сборке из репозитория tfgbuild.
// Игра ставится любым лаунчером (лицензия, TLauncher, Prism) - программе нужен только путь к её папке.
// Список файлов - manifest.json в репозитории (его пишет tools/publish.py).
using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.IO.Compression;
using System.Linq;
using System.Net;
using System.Net.Http;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;

namespace TfgUpdater
{
    public sealed class FileEntry
    {
        public string Path, Sha1, Url, Mode;
        public long Size;
    }

    public sealed class Manifest
    {
        public string Version, Tag, Forge, Archive, UpdaterVersion, UpdaterUrl;
        public List<string> Managed = new List<string>();
        public List<FileEntry> Files = new List<FileEntry>();
    }

    /// <summary>Что программа помнит о папке игры: версия, какие файлы ставила, суммы файлов (чтобы не пересчитывать).</summary>
    public sealed class State
    {
        public string Version;
        public Dictionary<string, string> Installed = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        public Dictionary<string, string> Cache = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);   // путь -> "размер|время|sha1"
    }

    public interface IReport
    {
        void Log(string text);
        void Progress(long done, long total, string what);
    }

    public sealed class Updater
    {
        public const string ManifestUrl = "https://raw.githubusercontent.com/beereolf-started/tfgbuild/main/manifest.json";
        /// <summary>Столько файлов из репозитория - и уже выгоднее скачать весь выпуск одним архивом.</summary>
        const int ArchiveThreshold = 200;
        const int Parallel = 6;

        static readonly HttpClient Http = MakeHttp();
        readonly string game;
        readonly IReport report;
        readonly string home;

        public Updater(string game, IReport report)
        {
            this.game = game;
            this.report = report;
            home = System.IO.Path.Combine(game, ".tfgbuild");
        }

        static HttpClient MakeHttp()
        {
            ServicePointManager.SecurityProtocol = SecurityProtocolType.Tls12;
            ServicePointManager.DefaultConnectionLimit = 16;
            var h = new HttpClient { Timeout = TimeSpan.FromMinutes(30) };
            h.DefaultRequestHeaders.UserAgent.ParseAdd("tfgbuild-updater/" + Program.Version);
            return h;
        }

        // ─── список файлов ───────────────────────────────────────────────────

        public static async Task<Manifest> FetchManifest()
        {
            // метка времени - мимо кеша GitHub: новый выпуск виден сразу
            // TFG_MANIFEST_URL - другой список (для проверки выпуска до отправки)
            string url = Environment.GetEnvironmentVariable("TFG_MANIFEST_URL") ?? ManifestUrl;
            string json = await Http.GetStringAsync(url + "?t=" + DateTime.UtcNow.Ticks);
            var js = new JavaScriptSerializer { MaxJsonLength = int.MaxValue };
            var d = (Dictionary<string, object>)js.DeserializeObject(json);
            var m = new Manifest
            {
                Version = Str(d, "version"), Tag = Str(d, "tag"), Forge = Str(d, "forge"), Archive = Str(d, "archive")
            };
            object u;
            if (d.TryGetValue("updater", out u) && u is Dictionary<string, object> ud)
            {
                m.UpdaterVersion = Str(ud, "version");
                m.UpdaterUrl = Str(ud, "url");
            }
            object managed;
            if (d.TryGetValue("managed", out managed))
                foreach (var x in (object[])managed) m.Managed.Add((string)x);
            foreach (Dictionary<string, object> f in (object[])d["files"])
                m.Files.Add(new FileEntry
                {
                    Path = Str(f, "path"), Sha1 = Str(f, "sha1"), Url = Str(f, "url"), Mode = Str(f, "mode"),
                    Size = Convert.ToInt64(f["size"])
                });
            return m;
        }

        static string Str(Dictionary<string, object> d, string k)
        {
            object v;
            return d.TryGetValue(k, out v) && v != null ? v.ToString() : null;
        }

        // ─── состояние папки ─────────────────────────────────────────────────

        public State LoadState()
        {
            var s = new State();
            string p = System.IO.Path.Combine(home, "state.json");
            if (!File.Exists(p)) return s;
            try
            {
                var d = (Dictionary<string, object>)new JavaScriptSerializer { MaxJsonLength = int.MaxValue }.DeserializeObject(File.ReadAllText(p, Encoding.UTF8));
                s.Version = Str(d, "version");
                foreach (var kv in (Dictionary<string, object>)d["installed"]) s.Installed[kv.Key] = (string)kv.Value;
                foreach (var kv in (Dictionary<string, object>)d["cache"]) s.Cache[kv.Key] = (string)kv.Value;
            }
            catch (Exception)
            {
                // испорчено - начнём заново: всё проверится по суммам
            }
            return s;
        }

        void SaveState(State s)
        {
            Directory.CreateDirectory(home);
            var o = new Dictionary<string, object> { { "version", s.Version }, { "installed", s.Installed }, { "cache", s.Cache } };
            string tmp = System.IO.Path.Combine(home, "state.json.tmp");
            File.WriteAllText(tmp, new JavaScriptSerializer { MaxJsonLength = int.MaxValue }.Serialize(o), new UTF8Encoding(false));
            string dst = System.IO.Path.Combine(home, "state.json");
            if (File.Exists(dst)) File.Delete(dst);
            File.Move(tmp, dst);
        }

        /// <summary>Сумма файла; если размер и время не менялись с прошлого раза - из памяти.</summary>
        string Hash(State s, string rel)
        {
            string full = Full(rel);
            var fi = new FileInfo(full);
            if (!fi.Exists) return null;
            string key = fi.Length + "|" + fi.LastWriteTimeUtc.Ticks + "|";
            string c;
            if (s.Cache.TryGetValue(rel, out c) && c.StartsWith(key, StringComparison.Ordinal)) return c.Substring(key.Length);
            string h = Sha1(full);
            s.Cache[rel] = key + h;
            return h;
        }

        static string Sha1(string path)
        {
            using (var sha = SHA1.Create())
            using (var f = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite, 1 << 16))
                return BitConverter.ToString(sha.ComputeHash(f)).Replace("-", "").ToLowerInvariant();
        }

        string Full(string rel)
        {
            return System.IO.Path.Combine(game, rel.Replace('/', System.IO.Path.DirectorySeparatorChar));
        }

        // ─── Forge ───────────────────────────────────────────────────────────

        /// <summary>Версия Forge 1.20.1, которую видно рядом с папкой игры (TLauncher, обычный лаунчер, Prism); null - не нашли.</summary>
        public string FindForge()
        {
            var places = new List<string> { System.IO.Path.Combine(game, "versions") };
            var parent = Directory.GetParent(game);
            if (parent != null)
            {
                places.Add(System.IO.Path.Combine(parent.FullName, "versions"));
                string mmc = System.IO.Path.Combine(parent.FullName, "mmc-pack.json");               // Prism / MultiMC
                if (File.Exists(mmc))
                {
                    string t = File.ReadAllText(mmc);
                    int i = t.IndexOf("\"net.minecraftforge\"", StringComparison.Ordinal);
                    if (i >= 0)
                    {
                        var m = System.Text.RegularExpressions.Regex.Match(t.Substring(i), "\"version\"\\s*:\\s*\"([0-9.]+)\"");
                        if (m.Success) return m.Groups[1].Value;
                    }
                }
            }
            foreach (string dir in places)
            {
                if (!Directory.Exists(dir)) continue;
                foreach (string f in Directory.EnumerateFiles(dir, "*.json", SearchOption.AllDirectories))
                {
                    var m = System.Text.RegularExpressions.Regex.Match(File.ReadAllText(f), @"net\.minecraftforge:forge:1\.20\.1-([0-9.]+)");
                    if (m.Success) return m.Groups[1].Value;
                }
            }
            return null;
        }

        // ─── обновление ──────────────────────────────────────────────────────

        public sealed class Plan
        {
            public List<FileEntry> Download = new List<FileEntry>();
            public List<string> Backup = new List<string>();           // перед заменой: игрок менял и сборка меняла
            public List<string> Remove = new List<string>();           // лишнее в папках сборки - в резервную копию
            public List<FileEntry> Same = new List<FileEntry>();
            public int KeptUserChanges;
        }

        public Plan MakePlan(Manifest m, State s)
        {
            var plan = new Plan();
            var wanted = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            long done = 0, total = m.Files.Count;
            foreach (var f in m.Files)
            {
                wanted.Add(f.Path);
                report.Progress(++done, total, "Проверка файлов");
                string have = Hash(s, f.Path);
                if (have == f.Sha1) { plan.Same.Add(f); continue; }
                if (have != null && f.Mode == "merge")
                {
                    string installed;
                    s.Installed.TryGetValue(f.Path, out installed);
                    if (installed == f.Sha1) { plan.KeptUserChanges++; continue; }   // сборка этот конфиг не меняла - настройки игрока
                    if (installed != have) plan.Backup.Add(f.Path);                   // менял игрок - сохраним его вариант
                }
                plan.Download.Add(f);
            }
            var keep = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            string keepFile = System.IO.Path.Combine(home, "keep.txt");                 // свои моды игрока, которые не трогать
            if (File.Exists(keepFile))
                foreach (string line in File.ReadAllLines(keepFile)) if (line.Trim().Length > 0) keep.Add(line.Trim().Replace('\\', '/'));
            foreach (string dir in m.Managed)
            {
                string full = Full(dir);
                if (!Directory.Exists(full)) continue;
                foreach (string f in Directory.EnumerateFiles(full, "*", SearchOption.AllDirectories))
                {
                    string rel = f.Substring(game.Length).TrimStart('\\', '/').Replace('\\', '/');
                    if (!wanted.Contains(rel) && !keep.Contains(rel) && !keep.Contains(System.IO.Path.GetFileName(rel))) plan.Remove.Add(rel);
                }
            }
            return plan;
        }

        public async Task Run(Manifest m, CancellationToken stop)
        {
            if (Process.GetProcessesByName("javaw").Length > 0 || Process.GetProcessesByName("java").Length > 0)
                report.Log("Похоже, запущена игра или лаунчер на Java. Если игра открыта - закройте её, иначе моды не заменить.");
            var s = LoadState();
            var plan = MakePlan(m, s);
            SaveState(s);                                                                  // суммы уже посчитаны - не терять
            long bytes = plan.Download.Sum(f => f.Size);
            report.Log(string.Format("Сборка {0}: скачать {1} файлов ({2:F1} МБ), убрать лишних {3}, без изменений {4}.",
                m.Version, plan.Download.Count, bytes / 1048576.0, plan.Remove.Count, plan.Same.Count));
            if (plan.KeptUserChanges > 0) report.Log("Оставлены ваши настройки в конфигах: " + plan.KeptUserChanges + " (сборка их не меняла).");

            string stamp = DateTime.Now.ToString("yyyy-MM-dd_HH-mm-ss");
            string backup = System.IO.Path.Combine(home, "backup", stamp);
            foreach (string rel in plan.Backup) MoveTo(rel, backup, false);
            foreach (string rel in plan.Remove) MoveTo(rel, backup, true);
            if (plan.Backup.Count + plan.Remove.Count > 0)
                report.Log("Старые и лишние файлы перенесены в " + backup);

            // много файлов из репозитория - одним архивом выпуска, остальные по одному
            var fromRepo = plan.Download.Where(f => f.Url.Contains("raw.githubusercontent.com")).ToList();
            var single = plan.Download;
            if (fromRepo.Count >= ArchiveThreshold && !string.IsNullOrEmpty(m.Archive))
            {
                await FromArchive(m, fromRepo, s, stop);
                single = plan.Download.Where(f => !fromRepo.Contains(f) || Hash(s, f.Path) != f.Sha1).ToList();
            }
            await DownloadAll(single, s, stop);

            foreach (var f in m.Files) if (Hash(s, f.Path) == f.Sha1) s.Installed[f.Path] = f.Sha1;
            foreach (string rel in plan.Remove) { s.Installed.Remove(rel); s.Cache.Remove(rel); }
            var failed = m.Files.Where(f => f.Mode == "force" && Hash(s, f.Path) != f.Sha1).ToList();
            if (failed.Count == 0) s.Version = m.Version;
            SaveState(s);
            if (failed.Count > 0)
            {
                report.Log("Не скачалось файлов: " + failed.Count + ". Запустите обновление ещё раз.");
                foreach (var f in failed.Take(10)) report.Log("   " + f.Path);
                throw new IOException("обновление не закончено");
            }
            report.Log("Готово: сборка " + m.Version + ". Запускайте игру своим лаунчером.");
        }

        void MoveTo(string rel, string backup, bool forget)
        {
            string src = Full(rel);
            if (!File.Exists(src)) return;
            string dst = System.IO.Path.Combine(backup, rel.Replace('/', System.IO.Path.DirectorySeparatorChar));
            Directory.CreateDirectory(System.IO.Path.GetDirectoryName(dst));
            if (File.Exists(dst)) File.Delete(dst);
            if (forget) File.Move(src, dst);
            else File.Copy(src, dst);
        }

        async Task FromArchive(Manifest m, List<FileEntry> files, State s, CancellationToken stop)
        {
            string zip = System.IO.Path.Combine(home, "release.zip");
            Directory.CreateDirectory(home);
            report.Log("Скачиваю выпуск одним архивом...");
            try
            {
                using (var resp = await Http.GetAsync(m.Archive, HttpCompletionOption.ResponseHeadersRead, stop))
                {
                    resp.EnsureSuccessStatusCode();
                    long? len = resp.Content.Headers.ContentLength;
                    using (var src = await resp.Content.ReadAsStreamAsync())
                    using (var dst = new FileStream(zip, FileMode.Create, FileAccess.Write))
                    {
                        var buf = new byte[1 << 16];
                        long got = 0;
                        int n;
                        while ((n = await src.ReadAsync(buf, 0, buf.Length, stop)) > 0)
                        {
                            await dst.WriteAsync(buf, 0, n, stop);
                            got += n;
                            report.Progress(got, len ?? Math.Max(got, 1), "Архив выпуска: " + (got / 1048576) + " МБ");
                        }
                    }
                }
                var want = files.ToDictionary(f => f.Path, StringComparer.OrdinalIgnoreCase);
                using (var z = ZipFile.OpenRead(zip))
                {
                    long done = 0;
                    foreach (var e in z.Entries)
                    {
                        // в архиве GitHub всё лежит в папке <репозиторий>-<метка>/
                        int slash = e.FullName.IndexOf('/');
                        if (slash < 0) continue;
                        string inRepo = e.FullName.Substring(slash + 1);
                        if (!inRepo.StartsWith("pack/", StringComparison.Ordinal)) continue;
                        FileEntry f;
                        if (!want.TryGetValue(inRepo.Substring(5), out f)) continue;
                        string part = Full(f.Path) + ".tfgpart";
                        Directory.CreateDirectory(System.IO.Path.GetDirectoryName(part));
                        e.ExtractToFile(part, true);
                        Place(f, part, s);
                        report.Progress(++done, want.Count, "Распаковка");
                    }
                }
            }
            catch (Exception ex) when (!(ex is OperationCanceledException))
            {
                report.Log("Архив не удался (" + ex.Message + ") - качаю по одному файлу.");
            }
            finally
            {
                try { File.Delete(zip); } catch (Exception) { }
            }
        }

        async Task DownloadAll(List<FileEntry> files, State s, CancellationToken stop)
        {
            if (files.Count == 0) return;
            long total = files.Sum(f => f.Size), done = 0;
            var queue = new ConcurrentQueue<FileEntry>(files.OrderByDescending(f => f.Size));
            var errors = new ConcurrentBag<string>();
            var workers = Enumerable.Range(0, Parallel).Select(_ => Task.Run(async () =>
            {
                FileEntry f;
                while (queue.TryDequeue(out f))
                {
                    stop.ThrowIfCancellationRequested();
                    for (int attempt = 1; ; attempt++)
                    {
                        try
                        {
                            string part = Full(f.Path) + ".tfgpart";
                            Directory.CreateDirectory(System.IO.Path.GetDirectoryName(part));
                            using (var resp = await Http.GetAsync(f.Url, HttpCompletionOption.ResponseHeadersRead, stop))
                            {
                                resp.EnsureSuccessStatusCode();
                                using (var src = await resp.Content.ReadAsStreamAsync())
                                using (var dst = new FileStream(part, FileMode.Create, FileAccess.Write))
                                    await src.CopyToAsync(dst, 1 << 16, stop);
                            }
                            lock (s) Place(f, part, s);
                            break;
                        }
                        catch (Exception ex) when (!(ex is OperationCanceledException) && attempt < 3)
                        {
                            await Task.Delay(1500 * attempt, stop);
                        }
                        catch (Exception ex) when (!(ex is OperationCanceledException))
                        {
                            errors.Add(f.Path + ": " + ex.Message);
                            break;
                        }
                    }
                    report.Progress(Interlocked.Add(ref done, f.Size), total, "Скачивание: " + System.IO.Path.GetFileName(f.Path));
                }
            })).ToArray();
            await Task.WhenAll(workers);
            foreach (string e in errors.Take(10)) report.Log("Ошибка: " + e);
        }

        /// <summary>Скачанное - на место, только если сумма сошлась (битый файл не ставим).</summary>
        void Place(FileEntry f, string part, State s)
        {
            if (Sha1(part) != f.Sha1)
            {
                File.Delete(part);
                throw new IOException("файл пришёл повреждённым: " + f.Path);
            }
            string dst = Full(f.Path);
            if (File.Exists(dst)) File.Delete(dst);
            File.Move(part, dst);
            s.Cache.Remove(f.Path);
        }
    }
}
