"""Выпуск сборки: из папки игры - в репозиторий tfgbuild и список файлов manifest.json.

    python -I tools/publish.py --source "<папка игры>" --version 38.0 [--allow-missing]

Что входит в сборку - INCLUDE/EXCLUDE ниже. Откуда игроку качать каждый файл:
  - моды и ресурспаки, которые есть на Modrinth, - прямо с Modrinth (по контрольной сумме файла);
  - моды с открытой лицензией (MIT, GPL, ...) и наши - из репозитория (папка pack/);
  - закрытые (All Rights Reserved) - только по ссылке из sources.json (CurseForge): класть их в
    публичный репозиторий нельзя. Нет ссылки - выпуск не собирается (или --allow-missing: без них);
  - всё остальное (конфиги, скрипты KubeJS, ресурсы) - из репозитория.
Ссылки на файлы репозитория - по метке выпуска (v<версия>): у каждого выпуска свои неизменные файлы.
Сам git (коммит, метку, отправку) делают отдельно - после проверки.
"""
import argparse
import datetime
import fnmatch
import hashlib
import json
import os
import re
import shutil
import sys
import urllib.parse
import urllib.request
import zipfile

REPO = "beereolf-started/tfgbuild"
UPDATER_VERSION = "1.0"          # = Program.Version в updater/Program.cs
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PACK = os.path.join(ROOT, "pack")

# что входит в сборку (пути от папки игры)
INCLUDE = [
    "mods/*.jar",
    "config/**",
    "defaultconfigs/**",
    "kubejs/assets/**", "kubejs/data/**", "kubejs/config/**",
    "kubejs/server_scripts/**", "kubejs/startup_scripts/**", "kubejs/client_scripts/**",
    "resourcepacks/*.zip",
    "tacz/*.zip", "tacz/tacz-pre.toml",
    "emotes/*.json",
    "CustomSkinLoader/CustomSkinLoader.json",
]
EXCLUDE = [
    "config/resourceful-config-web.json",      # у каждого свой случайный пароль веб-панели
    "kubejs/config/probejs.json",              # настройки инструмента разработчика
    "*.bak", "*.old", "*.log", "*.tmp", "*/.DS_Store", "*/Thumbs.db",
]
# режимы: force - всегда как в сборке; merge - сборка меняет файл, только если сама его поменяла
# (настройки игрока в конфигах не затираются, пока сборка не трогает этот конфиг)
MERGE = ["config/**", "tacz/tacz-pre.toml"]
# папки, где у игрока не должно быть ничего чужого: лишнее (старые моды и скрипты) - в резервную копию
MANAGED = ["mods", "defaultconfigs", "kubejs/assets", "kubejs/data", "kubejs/server_scripts",
           "kubejs/startup_scripts", "kubejs/client_scripts"]
# лицензии, с которыми мод можно держать в своём репозитории
OPEN_LICENSE = re.compile(r"MIT|BSD|GPL|LGPL|Apache|MPL|Mozilla|CC0|Unlicense|ISC|Public License|zlib", re.I)
# наши моды (лежат в репозитории при любой лицензии)
OWN = ["tfgui-*.jar", "xaeromapsync-*.jar"]


def match(path, patterns):
    return any(fnmatch.fnmatchcase(path, p) or fnmatch.fnmatchcase(os.path.basename(path), p) for p in patterns)


def sha1(path):
    h = hashlib.sha1()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def collect(source):
    out = []
    for dirpath, _, files in os.walk(source):
        for f in files:
            rel = os.path.relpath(os.path.join(dirpath, f), source).replace("\\", "/")
            if match(rel, INCLUDE) and not match(rel, EXCLUDE):
                out.append(rel)
    return sorted(out)


def modrinth(hashes):
    """sha1 -> прямая ссылка Modrinth."""
    found = {}
    keys = list(hashes)
    for i in range(0, len(keys), 500):
        body = json.dumps({"hashes": keys[i:i + 500], "algorithm": "sha1"}).encode()
        req = urllib.request.Request("https://api.modrinth.com/v2/version_files", data=body,
                                     headers={"Content-Type": "application/json", "User-Agent": f"{REPO}/publish"})
        for h, v in json.load(urllib.request.urlopen(req, timeout=120)).items():
            for f in v["files"]:
                if f["hashes"].get("sha1") == h:
                    found[h] = f["url"]
    return found


def jar_license(path):
    try:
        with zipfile.ZipFile(path) as z:
            t = z.read("META-INF/mods.toml").decode("utf-8", "replace")
        m = re.search(r'^\s*license\s*=\s*"([^"]*)"', t, re.M)
        return m.group(1) if m else ""
    except Exception:
        return ""


def forge_version(source):
    """Версия Forge из папки версий лаунчера (рядом с игрой или внутри неё)."""
    for d in (os.path.join(source, "versions"), os.path.join(os.path.dirname(source), "versions")):
        if not os.path.isdir(d):
            continue
        for dirpath, _, files in os.walk(d):
            for f in files:
                if f.endswith(".json"):
                    with open(os.path.join(dirpath, f), encoding="utf-8", errors="replace") as fh:
                        m = re.search(r"net\.minecraftforge:forge:1\.20\.1-([0-9.]+)", fh.read())
                    if m:
                        return m.group(1)
    return None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--source", required=True)
    ap.add_argument("--version", required=True)
    ap.add_argument("--allow-missing", action="store_true")
    a = ap.parse_args()
    tag = "v" + a.version
    raw = f"https://raw.githubusercontent.com/{REPO}/{tag}/pack/"
    sources = {}
    sp = os.path.join(ROOT, "sources.json")
    if os.path.exists(sp):
        with open(sp, encoding="utf-8") as f:
            sources = json.load(f)

    paths = collect(a.source)
    sums = {p: sha1(os.path.join(a.source, p)) for p in paths}
    binaries = [p for p in paths if p.endswith((".jar", ".zip"))]
    mr = modrinth({sums[p] for p in binaries})

    files, hosted, missing = [], set(), []
    for p in paths:
        full = os.path.join(a.source, p)
        name = os.path.basename(p)
        url = mr.get(sums[p]) if p in binaries else None
        if not url and name in sources:
            url = sources[name]
        if not url and p.endswith(".jar"):
            lic = jar_license(full)
            if match(name, OWN) or OPEN_LICENSE.search(lic):
                hosted.add(p)
            else:
                missing.append(f"{p}  ({lic or 'лицензия не указана'})")
                continue
        elif not url and p.endswith(".zip") and p.startswith(("resourcepacks/", "tacz/")):
            missing.append(f"{p}  (ресурспак/пакет не найден на Modrinth)")
            continue
        elif not url:
            hosted.add(p)
        if p in hosted:
            url = raw + urllib.parse.quote(p)
        files.append({"path": p, "sha1": sums[p], "size": os.path.getsize(full), "url": url,
                      "mode": "merge" if match(p, MERGE) else "force"})

    if missing:
        print("Нет источника (на Modrinth нет, лицензия закрытая) - нужна ссылка в sources.json:")
        for m in missing:
            print("  -", m)
        if not a.allow_missing:
            sys.exit(1)

    # pack/ - ровно то, что лежит в репозитории в этом выпуске
    for dirpath, _, fs in os.walk(PACK):
        for f in fs:
            rel = os.path.relpath(os.path.join(dirpath, f), PACK).replace("\\", "/")
            if rel not in hosted:
                os.remove(os.path.join(dirpath, f))
    for p in hosted:
        dst = os.path.join(PACK, p)
        if os.path.exists(dst) and os.path.getsize(dst) == os.path.getsize(os.path.join(a.source, p)) and sha1(dst) == sums[p]:
            continue
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        shutil.copy2(os.path.join(a.source, p), dst)
    for dirpath, dirs, fs in os.walk(PACK, topdown=False):
        if not dirs and not fs and dirpath != PACK:
            os.rmdir(dirpath)

    manifest = {
        "format": 1,
        "name": "TerraFirmaGreg",
        "version": a.version,
        "tag": tag,
        "created": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "minecraft": "1.20.1",
        "forge": forge_version(a.source),
        "archive": f"https://codeload.github.com/{REPO}/zip/refs/tags/{tag}",
        "updater": {"version": UPDATER_VERSION, "url": f"https://github.com/{REPO}/raw/main/updater/TfgUpdater.exe"},
        "managed": MANAGED,
        "files": files,
    }
    with open(os.path.join(ROOT, "manifest.json"), "w", encoding="utf-8", newline="\n") as f:
        json.dump(manifest, f, ensure_ascii=False, indent=1)
        f.write("\n")
    total = sum(x["size"] for x in files)
    print(f"файлов {len(files)} ({total / 1048576:.0f} МБ): с Modrinth {sum(1 for x in files if 'cdn.modrinth.com' in x['url'])}, "
          f"из репозитория {len(hosted)}, по ссылкам {sum(1 for x in files if os.path.basename(x['path']) in sources)}; "
          f"нет источника {len(missing)}; Forge {manifest['forge']}")


if __name__ == "__main__":
    main()
