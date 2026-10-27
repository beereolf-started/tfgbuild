// priority: 5
"use strict";
/**
 * МИР ПОСЕЛЕНИЙ: где они стоят, чьи они, кто в них живёт и что там происходило.
 *
 * Здесь нет ни одного блока - только знание. Блоки ставит factions/street.js, жителей
 * выпускает factions/settlers.js, а этот файл отвечает на вопрос «что вообще есть в мире»
 * и держит это знание в данных сервера.
 *
 * ПОЧЕМУ ДЕТЕРМИНИРОВАННО. Поселение должно существовать раньше, чем игрок до него дойдёт:
 * о нём говорят гости, туда ходят караваны, оттуда приходят налётчики. Поэтому положение,
 * фракция, имя и состав жителей считаются из зерна мира и координат ячейки - одинаково на
 * любом сервере с тем же зерном и без единого загруженного чанка.
 *
 * СЕТКА. Мир разбит на ячейки по WD_CELL блоков. В каждой ячейке не больше одного поселения,
 * и оно смещено от середины не дальше WD_JITTER. Отсюда расстояние между соседями никогда
 * не меньше WD_CELL - 2*WD_JITTER = 2400 блоков (было 12000/2500 - втрое реже, по просьбе - чаще).
 *
 * ВЕРСИИ ЗАПИСЕЙ. Всё, что мы знаем о поселении, лежит в одной записи с полем v - версией
 * её устройства. Когда устройство меняется (а меняться оно будет), wdMigrate поднимает
 * старые записи до нынешней версии, а не выбрасывает их. Там же хранится снимок «как было
 * до стройки» (зоны отката), список поставленных построек с их шаблонами и палитрой, и
 * состав жителей - этого достаточно, чтобы поселение можно было снести и собрать заново
 * после любой правки скриптов.
 *
 * Команды: /tfgworld near | info | here | build | sim | forget
 */

const WD_SCHEMA = 3                  // версия устройства записей; растёт при изменениях
const WD_CELL = 4000                 // сторона ячейки сетки
const WD_JITTER = 800                // в таком круге от середины ячейки ищем площадку
const WD_SEARCH_STEP = 200           // с таким шагом перебираем места внутри ячейки
const WD_SEA = 64                    // ниже этого - вода; на дне моря поселений не ставим
const WD_HORIZON = 50000             // в таком радиусе мир определён заранее
const WD_MIN_FROM_BASE = 300         // ближе этого к базе игрока поселений не бывает: стройка выравнивает землю ~150 блоков вокруг
const WD_FLAT_RANGE = 10             // перепад высот на площадке - не больше этого
const WD_FLAT_STEP = 16              // с таким шагом щупаем рельеф
const WD_FLAT_HALF = 48              // на таком полуразмере площадки
const WD_EVENT_DAYS = 30             // события храним месяц, потом забываем
const WD_SIM_MAX_DAYS = 400          // за раз доигрываем не больше, чем столько дней
const WD_PREP_R = 144                // столько блоков вокруг середины прогружаем перед стройкой
const WD_PREP_TIMEOUT = 2400         // ждём прогрузки не дольше двух минут
const WD_AUTO_R = 1000               // игрок ближе этого к записи - поселение встаёт само
const WD_AUTO_EVERY = 200            // раз в десять секунд смотрим, не подошёл ли кто

var WD_SERVER = null
var WD_DATA = null

function wdLog(t) { try { console.log("[мир] " + t) } catch (e) { } }
function wdErr(w, e) { try { console.error("[мир] " + w + ": " + e) } catch (err) { } }
function wdRun(cmd) { try { return Number(WD_SERVER.runCommandSilent(cmd)) } catch (e) { return 0 } }

// ─── Хранение ────────────────────────────────────────────────────────────────

function wdLoad() {
    if (WD_DATA) return WD_DATA
    if (!WD_SERVER) return { schema: WD_SCHEMA, sites: {} }
    try { WD_DATA = JSON.parse(global.TFG_STORE.read(WD_SERVER.persistentData, "tfg_world") || "{}") }
    catch (e) { WD_DATA = {}; wdErr("чтение", e) }
    if (!WD_DATA.sites) WD_DATA.sites = {}
    if (!WD_DATA.schema) WD_DATA.schema = WD_SCHEMA
    wdMigrateAll()
    return WD_DATA
}

function wdSave() {
    if (!WD_SERVER || !WD_DATA) return
    var bad = global.TFG_STORE.write(WD_SERVER.persistentData, "tfg_world", JSON.stringify(WD_DATA))
    if (bad) wdErr("запись", bad)
}

/**
 * Подъём старых записей до нынешней версии. Каждая ступень - отдельный кусок кода,
 * который правит только своё; так поселения переживают любую переделку скриптов.
 */
function wdMigrate(site) {
    if (!site.v) site.v = 1
    // 1 -> 2: сетка стала крупнее, и место внутри ячейки теперь ищется по биому.
    // Непостроенные записи выбрасываем - пересчитаются заново; построенные не трогаем.
    if (site.v === 1) {
        if (!site.built) return null
        site.v = 2
    }
    // 2 -> 3: сетка втрое мельче (12000 -> 4000), записи новой сетки - под своими номерами (g...).
    // Непостроенные старые выбрасываем; построенные остаются «старыми» (legacy): их видит wdNear,
    // а ячейка новой сетки рядом с ними своего поселения не ставит.
    if (site.v === 2) {
        if (!site.built && site.state !== "строится" && site.state !== "перестраивается") return null
        site.legacy = true
        site.v = 3
    }
    return site
}

function wdMigrateAll() {
    var n = 0, dropped = 0
    for (var id in WD_DATA.sites) {
        var before = WD_DATA.sites[id].v || 1
        var kept = wdMigrate(WD_DATA.sites[id])
        if (!kept) { delete WD_DATA.sites[id]; dropped++; continue }
        if ((kept.v || 1) !== before) n++
    }
    if (dropped) wdLog("непостроенных записей пересчитается заново: " + dropped)
    if (WD_DATA.schema !== WD_SCHEMA) {
        wdLog("устройство записей поднято с версии " + WD_DATA.schema + " до " + WD_SCHEMA + ", записей правлено " + n)
        WD_DATA.schema = WD_SCHEMA
        wdSave()
    }
}

// ─── Зерно и случайность, одинаковая для всех ────────────────────────────────

/** Зерно мира: от него зависит всё расположение. Берём у самого мира, а не выдумываем. */
var WD_SEED = null
function wdSeed() {
    if (WD_SEED !== null) return WD_SEED
    WD_SEED = 0
    try {
        var s = String(WD_SERVER.overworld().getSeed())
        for (var i = 0; i < s.length; i++) WD_SEED = (WD_SEED * 31 + s.charCodeAt(i)) >>> 0
    } catch (e) { WD_SEED = 20260921 }
    return WD_SEED
}

/** Целое из набора чисел: одна и та же выборка на любом сервере с тем же зерном. */
function wdHash() {
    var h = 2166136261 ^ wdSeed()
    for (var i = 0; i < arguments.length; i++) {
        var v = Number(arguments[i]) | 0
        for (var b = 0; b < 4; b++) {
            h ^= (v >> (b * 8)) & 255
            h = (h + (h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24)) >>> 0
        }
    }
    return h >>> 0
}

function wdRand(h, n) { return n <= 1 ? 0 : (h % n) }
function wdPick(h, list) { return list[wdRand(h, list.length)] }

// ─── Имена в духе Rimworld ───────────────────────────────────────────────────

// Три склада слов: славянский, романский и латинский. Смешиваются нарочно - поселения
// стоят в одном мире, и названия у них должны звучать соседями, а не из разных книг.
const WD_N_SHAPE = ["Лощина", "Падь", "Излучина", "Займище", "Перекат", "Гряда", "Курган", "Заветерье",
    "Вал", "Яр", "Брод", "Плёс", "Урочище", "Слобода", "Погост", "Острог", "Застава", "Городище"]
const WD_N_ADJ = ["тёплых", "холодных", "железных", "медных", "соляных", "дымных", "волчьих", "вороньих",
    "тихих", "гулких", "сухих", "мокрых", "рыжих", "белых", "чёрных", "старых", "новых", "пьяных"]
const WD_N_THING = ["котлов", "мостов", "колодцев", "телег", "кузниц", "мельниц", "печей", "сетей",
    "камней", "коней", "бортей", "лодок", "ворот", "крестов", "костров", "амбаров", "дорог", "рудников"]
const WD_N_LAT = ["Винтергард", "Кастеллум", "Ференс", "Мортис", "Альбус", "Кальдера", "Виадук", "Фортуна",
    "Ново", "Петра", "Сильва", "Аквила", "Корвус", "Лупус", "Урса", "Вентус", "Терра", "Игнис"]
const WD_N_LAT2 = ["гард", "борг", "штадт", "полис", "кастр", "марка", "холл", "фьорд", "дорф", "бург"]
const WD_N_SAINT = ["Святой полис", "Святая застава", "Обитель", "Скит", "Собор", "Приют"]
const WD_N_PERSON = ["Петра", "Павла", "Ольги", "Бориса", "Глеба", "Марка", "Луки", "Игната", "Саввы",
    "Феодора", "Агнии", "Варвары", "Мартина", "Юлиана", "Корнелия"]

function wdName(h) {
    var kind = wdRand(h, 100)
    if (kind < 32) {
        // «Лощина тёплых котлов»
        return wdPick(wdHash(h, 1), WD_N_SHAPE) + " " + wdPick(wdHash(h, 2), WD_N_ADJ) + " " + wdPick(wdHash(h, 3), WD_N_THING)
    }
    if (kind < 52) {
        // «Винтергард», «Аквилабург»
        var a = wdPick(wdHash(h, 4), WD_N_LAT)
        return wdRand(wdHash(h, 5), 2) === 0 ? a : a + wdPick(wdHash(h, 6), WD_N_LAT2)
    }
    if (kind < 68) {
        // «Святой полис Петра»
        return wdPick(wdHash(h, 7), WD_N_SAINT) + " " + wdPick(wdHash(h, 8), WD_N_PERSON)
    }
    if (kind < 84) {
        // «Острог Луки», «Застава Варвары»
        return wdPick(wdHash(h, 9), WD_N_SHAPE) + " " + wdPick(wdHash(h, 10), WD_N_PERSON)
    }
    // «Ново-Кастеллум», «Старый Брод»
    var pre = wdRand(wdHash(h, 11), 2) === 0 ? "Ново-" : "Старый "
    return pre + wdPick(wdHash(h, 12), WD_N_LAT)
}

// ─── Рельеф и камень без загрузки чанков ─────────────────────────────────────

var WD_Heightmap = null
var WD_ChunkData = null
var WD_BlockPos = null

/** Высота земли в точке. Сперва пробуем спросить у генератора - он отвечает и по чужим чанкам. */
function wdHeight(level, x, z) {
    try {
        if (!WD_Heightmap) WD_Heightmap = Java.loadClass("net.minecraft.world.level.levelgen.Heightmap$Types")
        var src = level.getChunkSource()
        var gen = src.getGenerator()
        var h = gen.getBaseHeight(Math.round(x), Math.round(z), WD_Heightmap.WORLD_SURFACE_WG, level, src.randomState())
        var n = Number(h)
        if (isFinite(n) && n > -60) return n
    } catch (e) { }
    try { return Number(level.getHeight("WORLD_SURFACE_WG", Math.round(x), Math.round(z))) } catch (e) { }
    return 70
}

/** Ровное ли место: щупаем сетку вокруг и смотрим разброс высот. */
function wdFlat(level, x, z) {
    var lo = 1e9, hi = -1e9, n = 0, sum = 0
    for (var dx = -WD_FLAT_HALF; dx <= WD_FLAT_HALF; dx += WD_FLAT_STEP) {
        for (var dz = -WD_FLAT_HALF; dz <= WD_FLAT_HALF; dz += WD_FLAT_STEP) {
            var h = wdHeight(level, x + dx, z + dz)
            if (h < lo) lo = h
            if (h > hi) hi = h
            sum += h
            n++
        }
    }
    return { range: hi - lo, avg: n ? sum / n : 70, lo: lo, hi: hi }
}

/** Название биома в точке - по нему отсеиваем болота и горы. */
function wdBiome(level, x, z) {
    try {
        if (!WD_BlockPos) WD_BlockPos = Java.loadClass("net.minecraft.core.BlockPos")
        var pos = new WD_BlockPos(Math.round(x), 80, Math.round(z))
        return String(level.getBiome(pos).unwrapKey().get().location().getPath())
    } catch (e) { return "" }
}

const WD_BAD_BIOME = /swamp|marsh|bog|mountain|highland|peak|hill|canyon|badland|river|ocean|shore|beach|lake|volcan/
const WD_GOOD_BIOME = /plain|lowland|plateau|desert|savanna|steppe|field|meadow|grass/

/** Порода камня под поселением: спрашиваем данные чанка TFC, они считаются и без загрузки. */
function wdRock(level, x, z) {
    try {
        if (!WD_ChunkData) WD_ChunkData = Java.loadClass("net.dries007.tfc.world.chunkdata.ChunkData")
        if (!WD_BlockPos) WD_BlockPos = Java.loadClass("net.minecraft.core.BlockPos")
        var pos = new WD_BlockPos(Math.round(x), 80, Math.round(z))
        var data = WD_ChunkData.get(level, pos)
        var rock = data.getRockData().getRock(Math.round(x), 80, Math.round(z))
        var id = String(rock.raw().getRegistryName ? rock.raw().getRegistryName() : rock.raw())
        var m = id.match(/tfc:rock\/raw\/([a-z_]+)/)
        if (m) return m[1]
    } catch (e) { }
    // не вышло - берём камень по виду блока под землёй, если чанк всё-таки загружен
    try {
        var y = wdHeight(level, x, z)
        for (var d = 2; d < 12; d++) {
            var bid = String(level.getBlock(Math.round(x), Math.round(y) - d, Math.round(z)).id)
            var mm = bid.match(/^tfc:rock\/raw\/([a-z_]+)$/)
            if (mm) return mm[1]
        }
    } catch (e) { }
    return null
}

// ─── Ячейки и места ──────────────────────────────────────────────────────────

function wdCellOf(x, z) { return [Math.floor(x / WD_CELL), Math.floor(z / WD_CELL)] }
function wdSiteId(cx, cz) { return "g" + cx + "_" + cz }

/** Есть ли рядом построенное поселение старой сетки (ближе r). */
function wdLegacyNear(x, z, r) {
    var sites = wdLoad().sites
    for (var id in sites) {
        var s = sites[id]
        if (s.legacy && (s.x - x) * (s.x - x) + (s.z - z) * (s.z - z) < r * r) return true
    }
    return false
}

/** Есть ли в этой ячейке поселение и какое у него зерно. Без мира, только числа. */
function wdSpotOf(cx, cz) {
    var h = wdHash(cx, cz, 7)
    // не в каждой ячейке есть поселение: так мир не превращается в шахматную доску
    if (wdRand(h, 100) < 22) return null
    return { x: cx * WD_CELL + Math.floor(WD_CELL / 2), z: cz * WD_CELL + Math.floor(WD_CELL / 2), h: h }
}

/**
 * Поиск площадки внутри ячейки. Раньше точка была одна: попала в океан - поселения нет,
 * ровно это и случилось. Теперь перебираем места по сетке в круге WD_JITTER и смотрим
 * ПЕРВЫМ ДЕЛОМ НА БИОМ: равнина, плато, степь, пустыня - годится; болото, горы, холмы,
 * река, берег, океан - мимо, и дальше такую точку даже не щупаем. Потом уровень воды,
 * потом ровность. Перебор детерминированный и зависит только от зерна мира.
 *
 * Сторона ячейки и радиус подобраны так, что соседи всё равно не сойдутся ближе
 * WD_CELL - 2*WD_JITTER = 7000 блоков.
 */
function wdFindSpot(level, cx, cz) {
    var base = wdSpotOf(cx, cz)
    if (!base) return null
    var side = Math.floor(WD_JITTER * 2 / WD_SEARCH_STEP) + 1
    var total = side * side
    var start = wdRand(wdHash(base.h, 77), total)
    var step = 1 + 2 * wdRand(wdHash(base.h, 78), Math.floor(total / 2))
    var best = null
    for (var i = 0; i < total; i++) {
        var k = (start + i * step) % total
        var ox = (k % side) * WD_SEARCH_STEP - WD_JITTER
        var oz = Math.floor(k / side) * WD_SEARCH_STEP - WD_JITTER
        if (ox * ox + oz * oz > WD_JITTER * WD_JITTER) continue
        var x = base.x + ox, z = base.z + oz
        // 1. биом - первым делом
        var biome = wdBiome(level, x, z)
        if (!WD_GOOD_BIOME.test(biome) || WD_BAD_BIOME.test(biome)) continue
        // 2. не вода
        if (wdHeight(level, x, z) < WD_SEA + 3) continue
        // 3. ровность площадки
        var flat = wdFlat(level, x, z)
        if (flat.lo < WD_SEA + 2) continue
        if (flat.range > WD_FLAT_RANGE) {
            if (!best || flat.range < best.flat.range) best = { x: x, z: z, biome: biome, flat: flat }
            continue
        }
        return { x: x, z: z, y: Math.round(flat.avg), biome: biome, flat: flat, h: base.h, ok: true }
    }
    if (best && best.flat.range <= WD_FLAT_RANGE * 2) {
        return { x: best.x, z: best.z, y: Math.round(best.flat.avg), biome: best.biome, flat: best.flat, h: base.h, ok: true }
    }
    return { x: base.x, z: base.z, y: null, biome: null, flat: null, h: base.h, ok: false }
}

/**
 * Чья это ячейка. Раскраска решёткой: цвет = (2*cx + cz) mod N. При четырёх фракциях
 * это значит, что ни одна из восьми соседних ячеек не совпадает по цвету, а всего
 * поселений у каждой фракции поровну. Чтобы узор не бросался в глаза, соответствие
 * «цвет - фракция» своё у каждого куска 4x4 ячеек и выбирается от зерна мира.
 */
function wdFactionIds() {
    var ids = []
    try { ids = global.TFG_FACTIONS.list.filter(f => f.id !== "bandits").map(f => String(f.id)) } catch (e) { }
    if (!ids.length) ids = ["ash", "wind", "marvins", "alliance"]
    ids.sort()                                            // порядок не должен зависеть от загрузки файлов
    return ids
}

function wdFactionOf(cx, cz) {
    var ids = wdFactionIds()
    var n = ids.length
    var colour = (((cx * 2 + cz) % n) + n) % n
    var block = wdHash(Math.floor(cx / 4), Math.floor(cz / 4), 17)
    var perm = ids.slice()
    for (var i = perm.length - 1; i > 0; i--) {
        var j = wdRand(wdHash(block, i), i + 1)
        var t = perm[i]
        perm[i] = perm[j]
        perm[j] = t
    }
    return perm[colour]
}

// ─── Состав жителей: определён заранее ───────────────────────────────────────

const WD_ROLE_PLAN = ["правитель", "рыцарь", "стрелок", "рыцарь", "стрелок", "торговец", "торговец",
    "крестьянин", "крестьянин", "охотник", "лесоруб", "бард", "дружинник", "крестьянин", "дружинник"]

/** Люди поселения: правитель и торговцы известны поимённо ещё до постройки. */
function wdPeople(h, faction, size) {
    var people = { ruler: null, traders: [], roster: [] }
    var kinds = ["blacksmith", "weaponsmith", "armorer", "builder", "carpenter", "potter", "butcher"]
    for (var i = 0; i < size; i++) {
        var role = WD_ROLE_PLAN[i % WD_ROLE_PLAN.length]
        var hh = wdHash(h, 100 + i)
        var female = wdRand(hh, 100) < 45 && role !== "правитель"
        var person = {
            id: "p" + i, role: role, female: female,
            name: wdPersonName(hh, female),
            trade: role === "торговец" ? kinds[wdRand(wdHash(hh, 3), kinds.length)] : null,
        }
        people.roster.push(person)
        if (role === "правитель" && !people.ruler) people.ruler = person
        if (role === "торговец") people.traders.push(person)
    }
    return people
}

const WD_M_NAME = ["Бран", "Хальв", "Торд", "Гуннар", "Ивар", "Сигурд", "Эйнар", "Олаф", "Рагнар", "Хакон",
    "Ульф", "Бьёрн", "Кетиль", "Свен", "Арн", "Збышек", "Патрик", "Корнелий", "Марк", "Юлиан"]
const WD_F_NAME = ["Астрид", "Сигрид", "Хельга", "Ингрид", "Тора", "Фрейя", "Гудрун", "Ранди", "Сольвейг",
    "Ирса", "Агния", "Варвара", "Мирослава", "Злата", "Лукерья"]
const WD_NICK = ["Буйный", "Тихий", "Рябой", "Кривой", "Хмурый", "Щедрый", "Злобный", "Длинный", "Косматый",
    "Меткий", "Пегий", "Смурной", "Сытый", "Холодный", "Ржавый"]
const WD_NICK_F = ["Буйная", "Тихая", "Рябая", "Хмурая", "Щедрая", "Злобная", "Длинная", "Косматая",
    "Меткая", "Смурная", "Холодная", "Ржавая"]

function wdPersonName(h, female) {
    var base = female ? wdPick(h, WD_F_NAME) : wdPick(h, WD_M_NAME)
    if (wdRand(wdHash(h, 5), 100) < 45) {
        return base + " " + (female ? wdPick(wdHash(h, 6), WD_NICK_F) : wdPick(wdHash(h, 6), WD_NICK))
    }
    return base
}

// ─── Запись поселения ────────────────────────────────────────────────────────

/**
 * Сведения о поселении в ячейке. Запись создаётся при первом обращении и с тех пор живёт
 * в данных сервера: даже если правила расселения изменятся, уже известные поселения
 * останутся на своих местах.
 */
function wdSite(level, cx, cz, make) {
    var data = wdLoad()
    var id = wdSiteId(cx, cz)
    if (data.sites[id]) return data.sites[id]
    if (!make) return null
    var spot = wdFindSpot(level, cx, cz)
    if (!spot) return null
    if (spot.ok && wdLegacyNear(spot.x, spot.z, WD_CELL - 2 * WD_JITTER)) spot.ok = false   // рядом уже стоит старое

    var site = {
        v: WD_SCHEMA, id: id, cell: [cx, cz], x: spot.x, z: spot.z, y: spot.y,
        dim: "minecraft:overworld",
        name: wdName(wdHash(spot.h, 21)),
        faction: wdFactionOf(cx, cz),
        stone: null, biome: spot.biome, flat: spot.flat ? Math.round(spot.flat.range) : null,
        size: WD_MIN_SIZE + wdRand(wdHash(spot.h, 22), 8),  // столько построек в поселении (трущобы сверх)
        state: spot.ok ? "известно" : "нет площадки в ячейке", built: false, discovered: false,
        street: null, village: null,
        people: null,
        events: [], caravans: [], quests: [],
        lastSim: null, checkedAt: null,
        // снимок для пересборки: заполняется при постройке (см. wdRemember)
        stock: null,
    }
    site.people = wdPeople(wdHash(spot.h, 23), site.faction, site.size + 4)
    data.sites[id] = site
    wdSave()
    return site
}

/** Долить в запись то, что можно узнать только у мира: камень, биом, ровность. */
/** Добрать то, что не понадобилось при поиске: породу камня и высоту. */
function wdProbe(level, site) {
    if (site.stone && site.flat !== null && site.y) return site
    if (!site.biome) site.biome = wdBiome(level, site.x, site.z)
    if (site.flat === null || !site.y) {
        var flat = wdFlat(level, site.x, site.z)
        site.flat = Math.round(flat.range)
        site.y = Math.round(flat.avg)
    }
    site.stone = wdRock(level, site.x, site.z) || site.stone
    site.checkedAt = wdDay()
    wdSave()
    return site
}

/** Не ближе семи тысяч к базам игроков. Проверяем при попытке построить. */
function wdFarFromBases(site) {
    var ok = true
    try {
        global.TFG_SETTLEMENTS.all().forEach(f => {
            if (!f.base) return
            var dx = f.base.x - site.x, dz = f.base.z - site.z
            if (dx * dx + dz * dz < WD_MIN_FROM_BASE * WD_MIN_FROM_BASE) ok = false
        })
    } catch (e) { }
    return ok
}

/** Все известные поселения в радиусе. */
function wdNear(level, x, z, radius, make) {
    var out = []
    var r = Math.ceil(radius / WD_CELL) + 1
    var c = wdCellOf(x, z)
    for (var dx = -r; dx <= r; dx++) {
        for (var dz = -r; dz <= r; dz++) {
            var site = wdSite(level, c[0] + dx, c[1] + dz, make)
            if (!site) continue
            if (site.state === "нет площадки в ячейке" && !site.built) continue
            var ddx = site.x - x, ddz = site.z - z
            var d = Math.sqrt(ddx * ddx + ddz * ddz)
            if (d > radius) continue
            out.push({ site: site, dist: Math.round(d) })
        }
    }
    // построенные поселения старой, крупной сетки - под своими номерами, по ячейкам их не найти
    var sites = wdLoad().sites
    for (var id in sites) {
        var s = sites[id]
        if (!s.legacy) continue
        var lx = s.x - x, lz = s.z - z
        var ld = Math.sqrt(lx * lx + lz * lz)
        if (ld <= radius) out.push({ site: s, dist: Math.round(ld) })
    }
    out.sort((a, b) => a.dist - b.dist)
    return out
}

// ─── Календарь и события ─────────────────────────────────────────────────────

var WD_Calendars = null
function wdDay() {
    try {
        if (!WD_Calendars) WD_Calendars = Java.loadClass("net.dries007.tfc.util.calendar.Calendars")
        return Number(WD_Calendars.SERVER.getTotalCalendarDays())
    } catch (e) {
        try { return Math.floor(Number(WD_SERVER.overworld().getTime()) / 24000) } catch (err) { return 0 }
    }
}

/**
 * Событие поселения. В чат ничего не пишется - события складываются в запись и живут
 * месяц. Их читают гости и жители, когда до них доходит молва (см. задержку в знании).
 */
function wdEvent(site, kind, text, extra) {
    var day = wdDay()
    var ev = { day: day, kind: kind, text: text, site: site.id, x: site.x, z: site.z }
    if (extra) for (var k in extra) ev[k] = extra[k]
    site.events.push(ev)
    // месяц - и забыли
    site.events = site.events.filter(e => day - e.day <= WD_EVENT_DAYS)
    return ev
}

/**
 * Весть, которая касается всей фракции: ложится в записи её поселений. Дальше она
 * расходится по людям обычным порядком - с задержкой в два дня и только среди тех,
 * кто рядом (см. wdEventsAround).
 */
function wdFactionEvent(factionId, kind, text) {
    var data = wdLoad()
    var n = 0
    for (var id in data.sites) {
        var site = data.sites[id]
        if (factionId && site.faction !== factionId) continue
        wdEvent(site, kind, text, { faction: factionId || null })
        n++
        if (n >= 8) break                                  // весть не обязана дойти до каждого
    }
    if (n) wdSave()
    return n
}

/** Все события в округе, о которых уже могли услышать (с задержкой в два дня). */
function wdEventsAround(level, x, z, radius, delayDays) {
    var day = wdDay()
    var out = []
    wdNear(level, x, z, radius, false).forEach(n => {
        n.site.events.forEach(e => {
            if (day - e.day < (delayDays === undefined ? 2 : delayDays)) return
            if (day - e.day > WD_EVENT_DAYS) return
            out.push({ ev: e, dist: n.dist, site: n.site })
        })
    })
    out.sort((a, b) => a.dist - b.dist)
    return out
}

// ─── Упрощённая жизнь ненайденных поселений ──────────────────────────────────

const WD_SIM = [
    { w: 22, kind: "караван", text: "ушёл торговый караван" },
    { w: 18, kind: "караван", text: "вернулся караван с прибылью" },
    { w: 10, kind: "караван", text: "караван вернулся ни с чем" },
    { w: 12, kind: "урожай", text: "убрали урожай" },
    { w: 8, kind: "налёт", text: "отбили налёт разбойников" },
    { w: 3, kind: "налёт", text: "разбойники увели скот" },
    { w: 6, kind: "стройка", text: "подняли новый дом" },
    { w: 5, kind: "праздник", text: "справляли свадьбу" },
    { w: 4, kind: "смерть", text: "хоронили своего" },
    { w: 4, kind: "распря", text: "поругались с соседями" },
]

/**
 * Пока игрок не нашёл поселение, жизнь в нём идёт упрощённо: раз в день бросается кубик
 * и в записи появляется строка «случилось то-то». Ничего не ставится и не считается -
 * но когда игрок придёт, у поселения уже будет прошлое, о котором можно говорить.
 */
function wdSimulate(level, site, days) {
    var today = wdDay()
    if (site.lastSim === null || site.lastSim === undefined) site.lastSim = today - 1
    var from = Math.max(site.lastSim + 1, today - WD_SIM_MAX_DAYS)
    var made = 0
    for (var day = from; day <= today; day++) {
        var h = wdHash(site.cell[0], site.cell[1], day, 31)
        if (wdRand(h, 100) >= 35) continue                // не каждый день что-то случается
        var total = 0
        WD_SIM.forEach(s => { total += s.w })
        var roll = wdRand(wdHash(h, 1), total)
        var pick = WD_SIM[0]
        for (var i = 0; i < WD_SIM.length; i++) {
            roll -= WD_SIM[i].w
            if (roll < 0) { pick = WD_SIM[i]; break }
        }
        var ev = { day: day, kind: pick.kind, text: pick.text, site: site.id, x: site.x, z: site.z, sim: true }
        site.events.push(ev)
        made++
    }
    site.lastSim = today
    site.events = site.events.filter(e => today - e.day <= WD_EVENT_DAYS)
    if (made) wdSave()
    return made
}

// ─── Снимок для пересборки ───────────────────────────────────────────────────

/**
 * Что именно стоит в мире. Пишем это в запись при постройке: шаблоны, их повороты,
 * палитра, зоны отката и идентификаторы улицы с жителями. Когда устройство поселений
 * изменится, по этому снимку старое сносится и ставится заново - без ручной работы.
 */
function wdRemember(site, street, village) {
    site.built = true
    site.state = "построено"
    site.street = street ? street.id : null
    site.village = village ? village.id : null
    site.stock = {
        at: wdDay(), schema: WD_SCHEMA,
        stone: street ? street.stone : site.stone,
        zones: street ? (street.zones || []).slice() : [],
        buildings: street ? (street.buildings || []).map(b => ({
            type: b.type, name: b.name, x: b.x, y: b.y, z: b.z, steps: b.steps,
            size: b.size, wood: b.wood, zone: b.zone,
        })) : [],
        ring: street ? street.ring : null,
    }
    wdSave()
}

// ─── Наружу ──────────────────────────────────────────────────────────────────

global.TFG_WORLD = {
    schema: WD_SCHEMA,
    near: (level, x, z, r, make) => wdNear(level, x, z, r, make === undefined ? true : make),
    site: (level, cx, cz, make) => wdSite(level, cx, cz, make === undefined ? true : make),
    byId: id => wdLoad().sites[id] || null,
    all: () => wdLoad().sites,
    probe: (level, site) => wdProbe(level, site),
    event: (site, kind, text, extra) => wdEvent(site, kind, text, extra),
    factionEvent: (factionId, kind, text) => wdFactionEvent(factionId, kind, text),
    eventsAround: (level, x, z, r, delay) => wdEventsAround(level, x, z, r, delay),
    simulate: (level, site, days) => wdSimulate(level, site, days),
    remember: (site, street, village) => wdRemember(site, street, village),
    day: () => wdDay(),
    save: () => wdSave(),
    farFromBases: site => wdFarFromBases(site),
    startBuild: (level, site, owner) => wdStartBuild(level, site, owner),
}

// ─── Тик: жизнь ненайденных поселений ────────────────────────────────────────

var WD_LAST_SIM_DAY = -1

ServerEvents.tick(event => {
    if (!WD_SERVER) WD_SERVER = event.server
    // После перезапуска посреди стройки память о ней пропала, а тикеты forceload остались
    // в мире: снимаем их и возвращаем записи в «известно», иначе она не встанет никогда.
    if (!WD_RECOVERED && event.server.tickCount % 20 === 0) {
        WD_RECOVERED = true
        try {
            var sites = wdLoad().sites
            for (var rid in sites) {
                var rs = sites[rid]
                if (rs.state !== "строится" || (WD_PREP && WD_PREP.site.id === rid)) continue
                wdForceload(rs.dim, wdChunkRange(rs), false)
                rs.state = rs.built ? "построено" : "известно"
                wdLog(rs.name + ": стройка прервалась перезапуском - тикеты сняты, запись возвращена")
                wdSave()
            }
        } catch (e) { wdErr("восстановление", e) }
    }
    // стройка идёт каждую секунду: ждёт прогрузки и запускает улицу
    if (event.server.tickCount % 20 === 0) {
        try { wdPrepTick(event.server.overworld()) } catch (e) { wdErr("стройка", e) }
        try { wdRebuildTick(event.server.overworld()) } catch (e) { wdErr("перестройка", e) }
        // Пакетная стройка всего горизонта сама не запускается: поселения встают, когда
        // рядом (ближе WD_AUTO_R) появляется игрок. Очередь - только по команде buildall start.
        try { wdQueueTick(event.server.overworld()) } catch (e) { wdErr("пакетная стройка", e) }
    }
    if (event.server.tickCount % WD_AUTO_EVERY === 0) {
        try { wdAutoTick(event.server, event.server.overworld()) } catch (e) { wdErr("автопоявление", e) }
    }
    if (event.server.tickCount % 1200 !== 0) return          // раз в минуту
    try {
        var day = wdDay()
        if (day === WD_LAST_SIM_DAY) return
        WD_LAST_SIM_DAY = day
        var level = event.server.overworld()
        var data = wdLoad()
        var n = 0
        for (var id in data.sites) {
            var site = data.sites[id]
            if (site.built || site.state === "строится") continue   // построенное живёт по-настоящему
            n += wdSimulate(level, site, 1)
        }
        if (n) wdLog("упрощённая жизнь: событий за день " + n)
    } catch (e) { wdErr("тик", e) }
})

// ─── Команды ─────────────────────────────────────────────────────────────────

/**
 * СТРОЙКА ИЗДАЛЕКА. level.getHeight для непрогруженного чанка не ошибается, а молча
 * отдаёт дно мира - и вся раскладка улицы ложилась «в никуда»: издалека ничего не
 * появлялось, а подойдя, хозяин видел только крепость. Поэтому стройка идёт в три шага:
 *   1. прогрузка: на всю площадь ставятся тикеты forceload, и мы ждём, пока каждый чанк
 *      действительно загрузится и сгенерируется;
 *   2. стройка улицы тем же камнем, заселение заранее определёнными людьми;
 *   3. после заселения тикеты снимаются - мир снова живёт как обычно.
 * Одновременно строится одно поселение: стройка тяжёлая, толпой её не пускаем.
 */
var WD_PREP = null                   // { site, owner, r, at, stage, buildAt }
var WD_RECOVERED = false

function wdTell(owner, text) {
    if (!owner) { wdLog(text); return }
    wdRun("tellraw " + owner + " " + JSON.stringify({ text: String(text) }))
}

/** Прямоугольник чанков вокруг поселения. */
function wdChunkRange(site) {
    return {
        x1: Math.floor((site.x - WD_PREP_R) / 16), z1: Math.floor((site.z - WD_PREP_R) / 16),
        x2: Math.floor((site.x + WD_PREP_R) / 16), z2: Math.floor((site.z + WD_PREP_R) / 16),
    }
}

/** Поставить или снять тикеты. Команда берёт не больше 256 чанков - режем на куски 16x16. */
function wdForceload(dim, r, add) {
    var n = 0
    for (var cx = r.x1; cx <= r.x2; cx += 16) {
        for (var cz = r.z1; cz <= r.z2; cz += 16) {
            var ex = Math.min(cx + 15, r.x2), ez = Math.min(cz + 15, r.z2)
            n += wdRun("execute in " + dim + " run forceload " + (add ? "add " : "remove ") +
                (cx * 16) + " " + (cz * 16) + " " + (ex * 16) + " " + (ez * 16)) > 0 ? 1 : 0
        }
    }
    return n
}

/** Сколько чанков площади уже загружено. */
function wdLoaded(level, r) {
    var total = 0, loaded = 0
    for (var cx = r.x1; cx <= r.x2; cx++) {
        for (var cz = r.z1; cz <= r.z2; cz++) {
            total++
            var ok = false
            try { ok = !!level.hasChunk(cx, cz) } catch (e) {
                try { ok = !!level.getChunkSource().hasChunk(cx, cz) } catch (e2) { ok = true }
            }
            if (ok) loaded++
        }
    }
    return { total: total, loaded: loaded }
}

/** Начать стройку поселения. Возвращает текст ошибки или null. */
function wdStartBuild(level, site, owner) {
    if (WD_PREP) return "уже строится " + WD_PREP.site.name + " - дождитесь"
    if (site.built) return site.name + " уже построено"
    wdProbe(level, site)
    if (site.state === "нет площадки в ячейке") return site.name + ": в ячейке нет годной площадки"
    if (!wdFarFromBases(site)) return site.name + " ближе " + WD_MIN_FROM_BASE + " блоков к базе игроков - не ставим"
    var r = wdChunkRange(site)
    wdForceload(site.dim, r, true)
    WD_PREP = { site: site, owner: owner || null, r: r, at: Number(level.getTime()), stage: "прогрузка" }
    site.state = "строится"
    wdSave()
    wdLog(site.name + ": прогружаю площадь, чанков " + ((r.x2 - r.x1 + 1) * (r.z2 - r.z1 + 1)))
    return null
}

/** Отменить стройку и снять тикеты. */
function wdAbort(why) {
    var p = WD_PREP
    if (!p) return
    wdForceload(p.site.dim, p.r, false)
    if (p.site.state === "строится") p.site.state = "известно"
    // Неудача не повторяется по кругу: сутки ждём, после второй - место негодно (вручную /tfgworld build можно).
    // Раньше игрок рядом - и стройка шла заново каждую минуту, с выглаживанием и сотней слепков за раз.
    p.site.fails = (p.site.fails || 0) + 1
    try { p.site.failAt = Number(WD_SERVER.overworld().getTime()) } catch (e) { }
    if (p.site.fails >= 2) { p.site.state = "негодно"; wdLog(p.site.name + ": вторая неудача - место негодно, само не строится") }
    wdSave()
    wdTell(p.owner, "§c" + p.site.name + ": " + why)
    WD_PREP = null
}

/** Шаг стройки: ждём прогрузки, строим, заселяем, снимаем тикеты. */
function wdPrepTick(level) {
    var p = WD_PREP
    if (!p) return
    var now = Number(level.getTime())
    if (p.stage === "прогрузка") {
        var st = wdLoaded(level, p.r)
        if (st.loaded < st.total && now - p.at < WD_PREP_TIMEOUT) return
        if (st.loaded < st.total) wdLog(p.site.name + ": прогружено " + st.loaded + " из " + st.total + ", строю как есть")
        p.stage = "стройка"
        // Высоту и породу берём уже у прогруженного мира. До прогрузки порода не читалась
        // вовсе, и улица брала случайный камень вместо камня этой области.
        try { p.site.y = Number(level.getHeight("WORLD_SURFACE_WG", p.site.x, p.site.z)) } catch (e) { }
        var rock = wdRock(level, p.site.x, p.site.z)
        if (rock) p.site.stone = rock
        wdLog(p.site.name + ": порода области - " + (p.site.stone || "не определилась, возьму случайную"))
        var res = null
        // поселения подросли: старые записи при постройке и перестройке догоняют новый размер
        if (!(p.site.size >= WD_MIN_SIZE)) p.site.size = WD_MIN_SIZE + Math.max(0, (p.site.size || 8) - 8)
        try {
            res = global.TFG_STREET.build(level, p.site.x, p.site.z, p.site.size, p.owner || "мир",
                { stone: p.site.stone, faction: p.site.faction, name: p.site.name, site: p.site.id })
        } catch (e) { return wdAbort("улица не встала: " + e) }
        if (typeof res === "string") return wdAbort(res)
        var site = p.site
        var owner = p.owner
        var r = p.r
        try {
            global.TFG_SETTLERS.buildLater({
                street: res.id, owner: owner, faction: site.faction,
                roster: site.people ? site.people.roster : null,
                name: site.name, at: now,
                done: (village, n) => {
                    wdRemember(site, global.TFG_STREET.list()[res.id], village)
                    wdEvent(site, "основано", "поселение поднялось на месте", { built: true })
                    wdForceload(site.dim, r, false)
                    wdLog(site.name + " построено: улица " + res.id + ", жителей " + n + ", тикеты сняты")
                    WD_PREP = null
                },
            })
        } catch (e) { return wdAbort("заселение не запустилось: " + e) }
        p.stage = "заселение"
        p.buildAt = now
        wdTell(owner, "Строю " + site.name + " (" + site.faction + ", камень " + site.stone + "): построек " +
            res.buildings.length + ". Заселю, как только встанет последний блок.")
        return
    }
    // страховка: заселение так и не отчиталось за игровые сутки - снимаем тикеты сами
    if (p.stage === "заселение" && now - p.buildAt > 24000) {
        wdForceload(p.site.dim, p.r, false)
        wdLog(p.site.name + ": заселение не отчиталось за сутки, тикеты сняты")
        WD_PREP = null
    }
}

/**
 * Поселения встают сами (пункт 1.1): как только игрок подходит к записи ближе WD_AUTO_R,
 * она строится - и в уже исхоженных местах, и в новых.
 */
function wdAutoTick(server, level) {
    if (WD_PREP) return
    var players = []
    try {
        var raw = server.players
        if (raw && typeof raw.size === "function") for (var k = 0; k < raw.size(); k++) players.push(raw.get(k))
        else if (raw && raw.length !== undefined) for (var k2 = 0; k2 < raw.length; k2++) players.push(raw[k2])
    } catch (e) { return }
    for (var i = 0; i < players.length; i++) {
        var pl = players[i]
        try { if (String(pl.level.getDimension()) !== "minecraft:overworld") continue } catch (e) { continue }
        var near = wdNear(level, pl.getX(), pl.getZ(), WD_AUTO_R, true)
        for (var j = 0; j < near.length; j++) {
            var site = near[j].site
            if (site.built || site.state !== "известно") continue
            if (site.failAt && Number(level.getTime()) - site.failAt < 24000) continue      // не встало - сутки ждём
            var err = wdStartBuild(level, site, null)
            if (!err) { wdLog(site.name + ": игрок " + pl.username + " подошёл на " + near[j].dist + " бл., встаёт само"); return }
        }
    }
}

/**
 * ПАКЕТНАЯ СТРОЙКА. При первом запуске сервера с этим скриптом он сам перебирает все
 * поселения в радиусе WD_HORIZON от точки спавна и ставит их по одному, ближние первыми.
 * Очередь лежит в данных сервера и переживает перезапуски. Слепок местности для отката
 * снимает каждая стройка сама (зоны factions/zones.js) - как и при стройке по команде.
 *
 * Это тяжело: у каждого поселения прогружается и генерируется площадь в несколько сотен
 * чанков, поэтому очередь идёт строго по одному и её можно остановить (/tfgworld buildall stop).
 */
function wdQueue() {
    var data = wdLoad()
    if (!data.buildAll) data.buildAll = { on: false, order: [], done: 0, skipped: [], started: null }
    return data.buildAll
}

/** Собрать очередь: все годные места горизонта, от точки спавна по удалению. */
function wdQueueFill(level) {
    var q = wdQueue()
    var cx = 0, cz = 0
    try {
        var sp = level.getSharedSpawnPos()
        cx = Number(sp.getX())
        cz = Number(sp.getZ())
    } catch (e) { }
    var near = wdNear(level, cx, cz, WD_HORIZON, true)
    q.order = near.filter(n => !n.site.built).map(n => n.site.id)
    q.on = true
    q.started = wdDay()
    wdSave()
    wdLog("пакетная стройка: в очереди " + q.order.length + " поселений (от " + Math.round(cx) + " " + Math.round(cz) + ")")
    return q
}

/** Шаг очереди: если сейчас ничего не строится - берём следующее. */
function wdQueueTick(level) {
    var q = wdQueue()
    if (!q.on || WD_PREP) return
    while (q.order.length) {
        var id = q.order.shift()
        var site = wdLoad().sites[id]
        if (!site || site.built || site.state === "негодно") continue
        var err = wdStartBuild(level, site, null)
        if (!err) { wdSave(); return }
        q.skipped.push(id + ": " + err)
        wdLog("пакетная стройка: пропуск " + err)
    }
    q.on = false
    wdSave()
    wdLog("пакетная стройка закончена: пропущено " + q.skipped.length)
}

/**
 * Перестройка поселения на том же месте по нынешним правилам застройки. Запись поселения
 * остаётся - название, история, люди, - а хозяевами ставятся нынешние (поселение могли
 * захватить). Снос идёт откатом зон по тикам, поэтому новую стройку начинаем только когда
 * все старые зоны вернулись: иначе новые слепки запомнили бы старые дома.
 */
var WD_REBUILD = null                // { site, zones, owner, at }
const WD_MIN_SIZE = 12               // построек в поселении, не считая трущоб
const WD_REBUILD_TIMEOUT = 12000     // десять минут на снос

function wdCmdRebuild(ctx) {
    if (!WD_SERVER) WD_SERVER = ctx.source.getServer()
    var p = ctx.source.getPlayerOrException()
    if (WD_PREP || WD_REBUILD) { ctx.source.sendFailure(Text.of("§cСейчас уже строится или перестраивается другое поселение - дождитесь.")); return 1 }
    var near = wdNear(p.level, p.getX(), p.getZ(), 400, false)
        .filter(n => n.site.built && (n.site.street || n.site.state === "перестраивается"))
    if (!near.length) { ctx.source.sendFailure(Text.of("Рядом нет построенного поселения из реестра мира.")); return 1 }
    var site = near[0].site
    // перестройку прервал перезапуск сервера: старое уже снесено - просто строим
    if (site.state === "перестраивается" && !global.TFG_STREET.list()[site.street]) {
        WD_REBUILD = { site: site, zones: [], owner: String(p.uuid), at: Number(p.level.getTime()) }
        ctx.source.sendSuccess(Text.of("Продолжаю перестройку " + site.name + ": старое уже снесено, строю заново."), false)
        return 1
    }
    var street = null
    try { street = global.TFG_STREET.list()[site.street] } catch (e) { }
    if (!street) { ctx.source.sendFailure(Text.of("§c" + site.name + ": нет записи улицы " + site.street)); return 1 }
    // нынешние хозяева - из поселения жителей, а не из исходной записи
    try {
        var vs = global.TFG_SETTLERS.list()
        for (var vid in vs) if (vs[vid].settlement === street.id && vs[vid].faction) site.faction = vs[vid].faction
    } catch (e) { }
    var zones = (street.zones || []).slice()
    var res = null
    try { res = global.TFG_STREET.remove(street.id) } catch (e) { wdErr("снос для перестройки", e) }
    if (!res) { ctx.source.sendFailure(Text.of("§cНе вышло снести " + site.name)); return 1 }
    site.state = "перестраивается"                   // built остаётся: сама стройка сюда не полезет
    wdSave()
    WD_REBUILD = { site: site, zones: zones, owner: String(p.uuid), at: Number(p.level.getTime()) }
    ctx.source.sendSuccess(Text.of("Перестраиваю " + site.name + " (" + site.faction + "): сношу " + zones.length +
        " зон, как земля вернётся - строю заново тесной застройкой. Название, история и люди остаются."), false)
    return 1
}

// ─── Что лежит на месте поселения и как его очистить ─────────────────────────

const WD_RESET_R = 150               // черта места: зоны и улицы ближе этого к записи - его

function wdNearestSite(p) {
    var near = wdNear(p.level, p.getX(), p.getZ(), 600, true)
    return near.length ? near[0].site : null
}

/** Улицы и зоны в черте места. */
function wdOnSite(site) {
    var streets = [], zones = []
    try {
        var data = global.TFG_STREET.list()
        for (var id in data) {
            var st = data[id]
            if (Math.pow(st.x - site.x, 2) + Math.pow(st.z - site.z, 2) < WD_RESET_R * WD_RESET_R) streets.push(st)
        }
    } catch (e) { }
    try {
        global.TFG_ZONES.list().forEach(z => {
            var b = z.box
            if (!b) return
            // коробка зоны заходит в черту (а не только середина): большие зоны с серединой вдали тоже держат место
            var nx = Math.max(b.x1, Math.min(site.x, b.x2)), nz = Math.max(b.z1, Math.min(site.z, b.z2))
            if (Math.pow(nx - site.x, 2) + Math.pow(nz - site.z, 2) < WD_RESET_R * WD_RESET_R) zones.push(z)
        })
    } catch (e) { }
    return { streets: streets, zones: zones }
}

/** /tfgworld diag - что числится на месте ближайшего поселения. */
function wdCmdDiag(ctx) {
    if (!WD_SERVER) WD_SERVER = ctx.source.getServer()
    var p = ctx.source.getPlayerOrException()
    var site = wdNearestSite(p)
    if (!site) { ctx.source.sendFailure(Text.of("Записей мира в 600 блоках нет.")); return 0 }
    var on = wdOnSite(site)
    var byLabel = {}, restoring = 0
    on.zones.forEach(z => {
        var lab = String(z.label || "зона").replace(/ [a-z0-9_]+$/, "")
        byLabel[lab] = (byLabel[lab] || 0) + 1
        if (z.restoring) restoring++
    })
    var rows = ["§6" + site.name + " §7(" + site.id + ") на " + site.x + " " + site.z + ": состояние «" + site.state + "», построено " +
        !!site.built + ", улица " + (site.street || "нет") + ", неудач " + (site.fails || 0)]
    rows.push("§7улиц в черте " + WD_RESET_R + ": " + on.streets.length + (on.streets.length ? " - " + on.streets.map(st =>
        st.id + " (" + st.x + " " + st.z + ", построек " + (st.buildings || []).length + ", зон " + (st.zones || []).length + ")").join("; ") : ""))
    rows.push("§7зон в черте: " + on.zones.length + (restoring ? ", из них ждут отката " + restoring : "") +
        (on.zones.length ? " - " + Object.keys(byLabel).map(k => k + " " + byLabel[k]).join(", ") : ""))
    var vs = []
    try { var all = global.TFG_SETTLERS.list(); for (var vid in all) if (on.streets.some(st => st.id === all[vid].settlement)) vs.push(vid) } catch (e) { }
    rows.push("§7поселений жителей на этих улицах: " + vs.length + (vs.length ? " (" + vs.join(", ") + ")" : ""))
    try { rows.push("§7очередь отката зон сейчас: " + (global.TFG_ZONES.busy() ? "идёт" : "пуста")) } catch (e) { }
    ctx.source.sendSuccess(Text.of(rows.join("\n")), false)
    wdLog("диагностика " + site.name + ": " + rows.join(" | ").replace(/§./g, ""))
    return 1
}

/**
 * /tfgworld reset - снять с места ближайшего поселения всё, что на нём числится: улицы в черте (с жителями,
 * тропами и их зонами) сносятся, остальные зоны в черте откатываются, запись места - «известно», без неудач.
 * После конца отката (строки «возвращена как была» в логе) - /tfgworld build.
 */
function wdCmdReset(ctx, full) {
    if (!WD_SERVER) WD_SERVER = ctx.source.getServer()
    var p = ctx.source.getPlayerOrException()
    if (WD_PREP || WD_REBUILD) { ctx.source.sendFailure(Text.of("Сейчас идёт стройка или перестройка - дождитесь.")); return 0 }
    var site = wdNearestSite(p)
    if (!site) { ctx.source.sendFailure(Text.of("Записей мира в 600 блоках нет.")); return 0 }
    var on = wdOnSite(site)
    var streets = 0, zones = 0
    // улицы - снять с учёта (жители, тропы), их зоны - вместе со всеми остальными ниже
    on.streets.forEach(st => { try { if (global.TFG_STREET.forget(st.id)) streets++ } catch (e) { wdErr("снятие улицы " + st.id, e) } })
    var list = wdOnSite(site).zones
    if (full) {
        // от новых слепков к старым: последним ляжет самый первый, снятый с дикой земли
        list.sort((a, b) => Number(b.made || 0) - Number(a.made || 0))
        list.forEach(z => { try { if (!global.TFG_ZONES.restore(z.id, "место сброшено")) zones++ } catch (e) { } })
    } else {
        // быстро: зоны забыть, землю не трогать - новая стройка выровняет её сама
        list.forEach(z => { try { if (!global.TFG_ZONES.drop(z.id)) zones++ } catch (e) { } })
    }
    site.built = false
    site.state = "известно"
    site.street = null
    site.village = null
    site.fails = 0
    site.failAt = 0
    wdSave()
    ctx.source.sendSuccess(Text.of(site.name + ": снято улиц " + streets + ", зон " + (full ? "в откат " : "забыто ") + zones +
        (full ? ". Когда в логе закончатся строки «возвращена как была» - /tfgworld build." : ". Можно строить: /tfgworld build.")), false)
    wdLog(site.name + ": место сброшено (" + (full ? "с откатом" : "без отката") + ") - улиц " + streets + ", зон " + zones)
    return 1
}

function wdRebuildTick(level) {
    var r = WD_REBUILD
    if (!r) return
    var left = r.zones.filter(id => { try { return !!global.TFG_ZONES.get(id) } catch (e) { return false } }).length
    var busy = false
    try { busy = global.TFG_ZONES.busy() } catch (e) { }
    var now = Number(level.getTime())
    // Откат крупного поселения идёт дольше десяти минут. Пока очередь отката работает, ждём:
    // стройка поверх недооткатившихся зон затиралась бы откатом сразу после окончания.
    // Срок считаем от последнего продвижения, а не от начала сноса.
    if (r.left === undefined || left < r.left || busy) { if (r.left !== left || busy) r.at = now; r.left = left }
    if ((left || busy) && now - r.at < WD_REBUILD_TIMEOUT) return
    WD_REBUILD = null
    var site = r.site
    if (left || busy) wdLog(site.name + ": откат десять минут без движения (зон осталось " + left + "), строю как есть")
    site.built = false
    site.state = "известно"
    site.street = null
    site.village = null
    site.stock = null
    wdSave()
    var err = wdStartBuild(level, site, r.owner)
    if (err) { wdTell(r.owner, "§c" + site.name + ": " + err); return }
    wdEvent(site, "перестроено", "поселение отстроено заново на прежнем месте", {})
    wdSave()
    wdTell(r.owner, site.name + ": старое снесено, начинаю новую стройку.")
}

/** Команда: поставить ближайшее или названное поселение. */
function wdCmdBuild(ctx, id) {
    if (!WD_SERVER) WD_SERVER = ctx.source.getServer()
    var p = ctx.source.getPlayerOrException()
    var site = null
    if (id) site = wdLoad().sites[id]
    else {
        var near = wdNear(p.level, p.getX(), p.getZ(), 30000, true)
        site = near.length ? near[0].site : null
    }
    if (!site) { ctx.source.sendFailure(Text.of("Не нашёл такой записи.")); return 1 }
    var err = wdStartBuild(WD_SERVER.overworld(), site, String(p.uuid))
    if (err) { ctx.source.sendFailure(Text.of("§c" + err)); return 1 }
    ctx.source.sendSuccess(Text.of("Прогружаю площадь " + site.name + " (" + site.x + " " + site.z +
        ") - как загрузится, начну стройку. Можно оставаться где угодно."), false)
    return 1
}

ServerEvents.commandRegistry(event => {
    try {
        var Commands = event.commands
        var Arguments = event.arguments
        var str = name => Commands.argument(name, Arguments.STRING.create(event))
        var S = (ctx, name) => String(Arguments.STRING.getResult(ctx, name))

        event.register(Commands.literal("tfgworld").requires(s => s.hasPermission(2))
            // что есть в округе
            .then(Commands.literal("near").executes(ctx => {
                if (!WD_SERVER) WD_SERVER = ctx.source.getServer()
                var p = ctx.source.getPlayerOrException()
                var rows = []
                wdNear(p.level, p.getX(), p.getZ(), 30000, true).slice(0, 12).forEach(n => {
                    var s = n.site
                    rows.push("§f" + s.name + " §7(" + s.id + ") " + s.faction + ", " + n.dist + " бл., " +
                        s.x + " " + s.z + ", " + s.state + (s.built ? ", построено" : ""))
                })
                ctx.source.sendSuccess(Text.of(rows.length ? rows.join("\n") : "§7в тридцати тысячах блоков пусто"), false)
                return 1
            }))
            // всё, что мы знаем о ближайшем
            .then(Commands.literal("here").executes(ctx => {
                if (!WD_SERVER) WD_SERVER = ctx.source.getServer()
                var p = ctx.source.getPlayerOrException()
                var near = wdNear(p.level, p.getX(), p.getZ(), 30000, true)
                if (!near.length) { ctx.source.sendFailure(Text.of("Поселений поблизости нет.")); return 1 }
                var s = wdProbe(p.level, near[0].site)
                var ruler = s.people && s.people.ruler ? s.people.ruler.name : "никто"
                var traders = s.people ? s.people.traders.map(t => t.name + " (" + t.trade + ")").join(", ") : ""
                var last = s.events.slice(-5).map(e => "§7  день " + e.day + ": " + e.text).join("\n")
                ctx.source.sendSuccess(Text.of(
                    "§f" + s.name + " §7(" + s.id + ")\n" +
                    "§7фракция " + s.faction + ", камень " + (s.stone || "?") + ", биом " + (s.biome || "?") +
                    ", перепад " + (s.flat === null ? "?" : s.flat) + "\n" +
                    "§7на " + s.x + " " + s.z + " (" + near[0].dist + " бл.), состояние: " + s.state + "\n" +
                    "§7правитель: " + ruler + "\n§7торговцы: " + (traders || "нет") + "\n" +
                    "§7последнее:\n" + (last || "§7  тихо")), false)
                return 1
            }))
            // пакетная стройка: состояние, остановка, запуск заново
            .then(Commands.literal("buildall")
                .executes(ctx => {
                    if (!WD_SERVER) WD_SERVER = ctx.source.getServer()
                    var q = wdQueue()
                    var built = 0, all = wdLoad().sites
                    for (var bid in all) if (all[bid].built) built++
                    ctx.source.sendSuccess(Text.of("Пакетная стройка: " + (q.on ? "идёт" : "стоит") +
                        ", сейчас строится " + (WD_PREP ? WD_PREP.site.name + " (" + WD_PREP.stage + ")" : "ничего") +
                        ", в очереди " + q.order.length + ", построено всего " + built + ", пропущено " + q.skipped.length), false)
                    return 1
                })
                .then(Commands.literal("stop").executes(ctx => {
                    if (!WD_SERVER) WD_SERVER = ctx.source.getServer()
                    wdQueue().on = false
                    wdSave()
                    ctx.source.sendSuccess(Text.of("Пакетная стройка остановлена (текущее поселение достроится)."), false)
                    return 1
                }))
                .then(Commands.literal("start").executes(ctx => {
                    if (!WD_SERVER) WD_SERVER = ctx.source.getServer()
                    var q = wdQueueFill(WD_SERVER.overworld())
                    ctx.source.sendSuccess(Text.of("Пакетная стройка запущена: в очереди " + q.order.length + "."), false)
                    return 1
                })))
            // поставить поселение в мире по его записи
            // снести ближайшее поселение и отстроить заново по нынешним правилам, сохранив запись
            .then(Commands.literal("rebuild").executes(ctx => wdCmdRebuild(ctx)))
            .then(Commands.literal("diag").executes(ctx => wdCmdDiag(ctx)))
            .then(Commands.literal("reset").executes(ctx => wdCmdReset(ctx, false))
                .then(Commands.literal("full").executes(ctx => wdCmdReset(ctx, true))))
            .then(Commands.literal("build").executes(ctx => wdCmdBuild(ctx, null))
                .then(str("id").executes(ctx => wdCmdBuild(ctx, S(ctx, "id")))))
            // доиграть упрощённую жизнь за столько-то дней
            .then(Commands.literal("sim").then(Commands.argument("дней", Arguments.INTEGER.create(event)).executes(ctx => {
                if (!WD_SERVER) WD_SERVER = ctx.source.getServer()
                var p = ctx.source.getPlayerOrException()
                var days = Number(Arguments.INTEGER.getResult(ctx, "дней"))
                var near = wdNear(p.level, p.getX(), p.getZ(), 30000, true)
                var n = 0
                near.forEach(x => {
                    if (x.site.lastSim !== null && x.site.lastSim !== undefined) x.site.lastSim -= days
                    n += wdSimulate(p.level, x.site, days)
                })
                ctx.source.sendSuccess(Text.of("Доиграно дней: " + days + ", событий: " + n +
                    " в " + near.length + " поселениях"), false)
                return 1
            })))
            // забыть запись (пересоздастся заново по тем же правилам)
            .then(Commands.literal("forget").then(str("id").executes(ctx => {
                if (!WD_SERVER) WD_SERVER = ctx.source.getServer()
                var id = S(ctx, "id")
                var data = wdLoad()
                if (!data.sites[id]) { ctx.source.sendFailure(Text.of("Нет такой записи.")); return 1 }
                delete data.sites[id]
                wdSave()
                ctx.source.sendSuccess(Text.of("Запись " + id + " забыта."), false)
                return 1
            }))))
        wdLog("/tfgworld зарегистрирован")
    } catch (err) {
        console.error("[мир] ошибка регистрации команд: " + err)
    }
})
