"use strict";
/**
 * УЛИЦА: зачаток поселения.
 *
 * Кладём главную дорогу шириной три блока - более-менее прямую, с лёгким изгибом по рельефу.
 * По обе стороны от неё ставим башню и три-четыре дома: камень у всех один, а дерево, поворот,
 * металл перил CreateDeco и цвет витражей - разные, чтобы улица не выглядела штамповкой.
 * Каждый дом получает ремесло хозяина (портной, мясник, оружейник, крестьянин) - это видно
 * по содержимому сундуков и полок. От двери к дороге идёт отвилок шириной два блока.
 *
 * Людей и ИИ здесь пока нет: задача - посмотреть, как улица ложится на местность.
 * Всё лежит в зонах (factions/zones.js), поэтому /tfgstreet remove убирает улицу без следа.
 *
 * Команды: /tfgstreet place [домов] | remove | list
 */

var SR_SERVER = null

const SR_ROAD_W = 3                 // ширина главной дороги
const SR_PATH_W = 2                 // ширина отвилков ко входам
// шаг вдоль дороги и отступ от её оси считаются по размеру шаблонов (см. srBuild)
const SR_WIGGLE = 0.22              // насколько дорога гуляет вбок
const SR_MAX_DROP = 4               // допустимый перепад под постройкой

const SR_TRADES = ["портной", "мясник", "оружейник", "крестьянин"]

function srLog(t) { try { console.log("[улица] " + t) } catch (e) { } }
function srErr(w, e) { try { console.error("[улица] " + w + ": " + e) } catch (err) { } }
function srPick(list) { return list[Math.floor(Math.random() * list.length)] }

/** Все шаблоны по началу имени: "башня" или "дом". */
function srTemplates(prefix) {
    var out = []
    try {
        global.TFG_BLUEPRINTS.names().forEach(n => {
            var name = String(n).replace(/ \(.*\)$/, "")
            if (name.indexOf(prefix) === 0) out.push(name)
        })
    } catch (e) { srErr("список шаблонов", e) }
    return out
}

/** Камень шаблона по имени: "башня_андезит" -> "андезит", "дом_андезит-гнейс-пихта" -> "андезит". */
function srStoneOf(name) {
    var tail = String(name).replace(/^(башня|дом)_/, "")
    return tail.split("-")[0].replace(/_зеркало$/, "")
}

function srWoodOf(name) {
    var parts = String(name).replace(/^дом_/, "").replace(/_зеркало$/, "").split("-")
    return parts.length >= 3 ? parts[2] : ""
}

/** Камни, для которых есть и башня, и хотя бы два дома. */
function srCommonStones() {
    var towers = {}, houses = {}
    srTemplates("башня").forEach(n => { towers[srStoneOf(n)] = true })
    srTemplates("дом").forEach(n => {
        var st = srStoneOf(n)
        houses[st] = (houses[st] || 0) + 1
    })
    var out = []
    for (var st in towers) if (houses[st]) out.push(st)
    return out
}

// ─── Дорога ──────────────────────────────────────────────────────────────────

/**
 * Замостить клетку. Высоту НЕ считаем заранее: дорога ложится последней, уже после того как
 * постройки обкопали себе основание, и старая отметка отправила бы тропу лежать поверх земли.
 * Поэтому кладём в очередь саму задачу, а верхний блок ищем в момент укладки.
 */
function srPave(zone, level, x, z, material, cmds, done) {
    var k = x + "," + z
    if (done) { if (done[k]) return; done[k] = 1 }
    var dim = zone && zone.dim ? zone.dim : String(level.getDimension())
    cmds.push({ dim: dim, x: x, z: z, mat: material })
}

/**
 * Сгладить землю вокруг клетки: если сосед выше или ниже на блок, подводим его к середине.
 * Мелкая рябь у троп и дворов выглядит неряшливо и мешает ходить.
 */
function srSmoothAround(level, x, z, dim) {
    var hs = [], cells = []
    for (var dx = -1; dx <= 1; dx++) {
        for (var dz = -1; dz <= 1; dz++) {
            var cx = x + dx, cz = z + dz
            var t = srTop(level, cx, cz)
            hs.push(t)
            cells.push({ x: cx, z: cz, y: t })
        }
    }
    hs.sort((a, b) => a - b)
    var mid = hs[Math.floor(hs.length / 2)]
    cells.forEach(c => {
        if (c.y === mid) return
        if (Math.abs(c.y - mid) > 1) return                 // настоящий склон не трогаем
        var id = ""
        try { id = String(level.getBlock(c.x, c.y, c.z).id) } catch (e) { return }
        if (!srNatural(id)) return
        if (id.indexOf("grass_path") >= 0) return           // уже уложенную тропу не трогаем
        if (c.y > mid) {
            SR_SERVER.runCommandSilent("execute in " + dim + " run setblock " + c.x + " " + c.y + " " + c.z +
                " minecraft:air replace")
        } else {
            SR_SERVER.runCommandSilent("execute in " + dim + " run setblock " + c.x + " " + (c.y + 1) + " " + c.z +
                " " + id + " replace")
        }
    })
}

/**
 * Полировка троп после укладки. Каждая клетка тропы сверяется с соседними клетками тропы:
 * одиночный бугор срезается, одиночная ямка засыпается, и нигде клетка не отходит от
 * соседей больше чем на блок. Тропа становится непрерывной - без штучных блоков вверх и вниз.
 */
function srPolishPaths(job) {
    var level = SR_SERVER.overworld()
    try { level = SR_SERVER.getLevel(job.dim) || level } catch (e) { }
    var H = {}, H0 = {}, MAT = {}
    job.cells.forEach(c => {
        var x = Number(c[0]), z = Number(c[1])
        var top = global.TFG_STRUCTURES.top(level, x, z)
        var id = ""
        try { id = String(level.getBlock(x, top, z).id) } catch (e) { return }
        if (id.indexOf("grass_path") < 0) return            // под домом или занято - не тропа
        H[x + "," + z] = top
        H0[x + "," + z] = top
        MAT[x + "," + z] = id
    })
    for (var pass = 0; pass < 3; pass++) {
        for (var k in H) {
            var p = k.split(","), x = Number(p[0]), z = Number(p[1])
            var nb = []
            for (var dx = -1; dx <= 1; dx++) for (var dz = -1; dz <= 1; dz++) {
                if (!dx && !dz) continue
                var hn = H[(x + dx) + "," + (z + dz)]
                if (hn !== undefined) nb.push(hn)
            }
            if (nb.length < 2) continue
            nb.sort((a, b) => a - b)
            var h = H[k], t = h
            if (h > nb[nb.length - 1]) t = nb[nb.length - 1]       // бугор
            else if (h < nb[0]) t = nb[0]                            // ямка
            var med = nb[Math.floor(nb.length / 2)]
            t = Math.max(med - 1, Math.min(med + 1, t))
            H[k] = t
        }
    }
    var n = 0
    for (var k2 in H) {
        var h0 = H0[k2], t2 = H[k2]
        if (h0 === t2) continue
        var q = k2.split(","), cx = q[0], cz = q[1]
        if (t2 < h0) {
            SR_SERVER.runCommandSilent("execute in " + job.dim + " run fill " + cx + " " + (t2 + 1) + " " + cz + " " + cx + " " + h0 + " " + cz + " minecraft:air replace")
        } else {
            var g = "tfc:dirt/loam"
            try { g = String(global.TFG_STRUCTURES.groundState(level, Number(cx), Number(cz))) } catch (e) { }
            SR_SERVER.runCommandSilent("execute in " + job.dim + " run fill " + cx + " " + h0 + " " + cz + " " + cx + " " + (t2 - 1) + " " + cz + " " + g + " replace")
        }
        SR_SERVER.runCommandSilent("execute in " + job.dim + " run setblock " + cx + " " + t2 + " " + cz + " " + MAT[k2] + " replace")
        n++
    }
    srLog("тропы отполированы: поправлено клеток " + n)
}

/** Выполнить отложенное мощение: снимаем дёрн там, где земля оказалась в итоге. */
function srPaveNow(job) {
    var level = SR_SERVER.overworld()
    try { level = SR_SERVER.getLevel(job.dim) || level } catch (e) { }
    var top = global.TFG_STRUCTURES.top(level, job.x, job.z)
    var mat = job.mat === "@дёрн" ? srPathMat(level, job.x, job.z) : job.mat
    var id = ""
    try { id = String(level.getBlock(job.x, top, job.z).id) } catch (e) { }
    // по чужим блокам не ходим: если сверху оказалась постройка, клетку пропускаем
    if (id && !srNatural(id)) return
    // и под крышу не лезем: деревянный пол «прозрачен» для поиска земли, и тропа
    // однажды прошла сквозь первый этаж башни, вынеся всю обстановку
    for (var uy = 1; uy <= 8; uy++) {
        var above = ""
        try { above = String(level.getBlock(job.x, top + uy, job.z).id) } catch (e) { break }
        if (above === "minecraft:air") continue
        if (srManMade(above)) return
    }
    SR_SERVER.runCommandSilent("execute in " + job.dim + " run fill " + job.x + " " + (top + 1) + " " + job.z + " " +
        job.x + " " + (top + 3) + " " + job.z + " minecraft:air replace")
    // Рябь вокруг больше не правим: рельеф уже отполирован (srSmooth), а подсыпка соседей
    // по блоку сама и давала штучные бугры у троп. Тропу выглаживает srPolishPaths в конце.
    top = global.TFG_STRUCTURES.top(level, job.x, job.z)
    SR_SERVER.runCommandSilent("execute in " + job.dim + " run fill " + job.x + " " + (top + 1) + " " + job.z + " " +
        job.x + " " + (top + 3) + " " + job.z + " minecraft:air replace")
    SR_SERVER.runCommandSilent("execute in " + job.dim + " run setblock " + job.x + " " + top + " " + job.z +
        " " + mat + " replace")
}

// что считаем землёй: только по ней и можно протоптать тропу
const SR_NATURAL = ["dirt/", "grass/", "grass_path/", "rock/gravel/", "rock/cobble/", "rock/raw/",
    "rock/loose/", "sand/", "clay/", "mud/", "farmland/", "minecraft:dirt", "minecraft:grass"]
// рукотворное: под таким мостить нельзя - значит, мы внутри постройки
const SR_MANMADE = ["planks", "brick", "createdeco", "mcw", "glass", "thatch", "wool", "lamp",
    "smooth", "polished", "chiseled", "cut_", "slab", "stairs", "door", "_wall", "fence", "carpet"]
function srManMade(id) {
    for (var i = 0; i < SR_MANMADE.length; i++) if (id.indexOf(SR_MANMADE[i]) >= 0) return true
    return false
}

/**
 * Землёй считаем всё, что не жидкость и не чужая кладка. Перечислять породы поимённо
 * бессмысленно: в сборке их сотни, и на незнакомом грунте тропа раньше замирала на месте.
 */
function srNatural(id) {
    if (!id || id === "minecraft:air") return false
    if (id.indexOf("water") >= 0 || id.indexOf("lava") >= 0) return false
    if (srManMade(id)) return false
    return true
}

// снятый дёрн бывает только на этих почвах; на камне и песке тропинку не вытоптать
const SR_PATH_SOILS = ["loam", "silty_loam", "sandy_loam", "silt"]

/** Тропинка под цвет местной земли: дёрн снимают с той почвы, что лежит под ногами. */
function srPathMat(level, x, z) {
    var id = ""
    try { id = String(global.TFG_STRUCTURES.groundState(level, x, z)) } catch (e) { }
    for (var i = 0; i < SR_PATH_SOILS.length; i++) {
        if (id.indexOf("/" + SR_PATH_SOILS[i]) >= 0) return "tfc:grass_path/" + SR_PATH_SOILS[i]
    }
    return "tfc:grass_path/loam"
}

/** Точки главной дороги: прямая с лёгким изгибом. */
function srRoadPoints(cx, cz, dx, dz, length) {
    var pts = []
    var px = -dz, pz = dx                                  // поперёк дороги
    var phase = Math.random() * 6.28
    for (var t = 0; t <= length; t++) {
        var wob = Math.sin(phase + t * 0.06) * length * SR_WIGGLE * 0.12
        pts.push({ x: cx + dx * t + px * wob, z: cz + dz * t + pz * wob })
    }
    return pts
}

/**
 * Связная полоса вдоль ломаной. Раньше клетки ставились по одной на точку и дорога рвалась
 * на диагоналях: теперь каждый отрезок проходим мелким шагом и мостим круг нужного радиуса,
 * а уже уложенные клетки не трогаем повторно.
 */
function srLay(zone, level, pts, width, material, cmds, done) {
    if (!done) done = {}
    var r = (width - 1) / 2
    for (var i = 0; i < pts.length - 1; i++) {
        var a = pts[i], b = pts[i + 1]
        var dx = b.x - a.x, dz = b.z - a.z
        var len = Math.sqrt(dx * dx + dz * dz)
        var steps = Math.max(1, Math.ceil(len * 4))
        for (var st = 0; st <= steps; st++) {
            var t = st / steps
            var cxf = a.x + dx * t, czf = a.z + dz * t
            for (var ox = -Math.ceil(r); ox <= Math.ceil(r); ox++) {
                for (var oz = -Math.ceil(r); oz <= Math.ceil(r); oz++) {
                    var gx = Math.round(cxf) + ox, gz = Math.round(czf) + oz
                    if (Math.abs(gx - cxf) > r + 0.5 || Math.abs(gz - czf) > r + 0.5) continue
                    srPave(zone, level, gx, gz, material, cmds, done)
                }
            }
        }
    }
    return done
}

/** Ближайшая к точке клетка дороги. */
function srNearest(pts, x, z) {
    var best = pts[0], bd = 1e9
    pts.forEach(p => {
        var d = (p.x - x) * (p.x - x) + (p.z - z) * (p.z - z)
        if (d < bd) { bd = d; best = p }
    })
    return best
}

/**
 * Дорожка от порога к дороге: сперва пара шагов прямо от двери (чтобы выход был по центру
 * крыльца), затем уголком до ближайшей точки дороги. Без диагоналей - тропинка читается ровной.
 */
function srBranch(zone, level, door, out, road, material, cmds, done) {
    var pts = [{ x: door.x, z: door.z }]
    var px = door.x + out.dx * 2, pz = door.z + out.dz * 2
    pts.push({ x: px, z: pz })
    var near = srNearest(road, px, pz)
    // сначала идём вдоль оси выхода, потом поперёк: получается аккуратный угол
    if (out.dx !== 0) {
        pts.push({ x: near.x, z: pz })
        pts.push({ x: near.x, z: near.z })
    } else {
        pts.push({ x: px, z: near.z })
        pts.push({ x: near.x, z: near.z })
    }
    srLay(zone, level, pts.map(p => ({ x: Math.round(p.x), z: Math.round(p.z) })), SR_PATH_W, material, cmds, done)
}

// ─── Каталог и состав поселения ──────────────────────────────────────────────

/**
 * Разбор шаблонов по назначению: { назначение: [имена] }. По камню больше не делим -
 * порода подменяется при постановке, поэтому любой шаблон годится для любой улицы.
 */
// свои шаблоны: башня, форт, особняк, большой и малый дом, обычный дом, трущобы (и их зеркала)
const SR_OURS = /^(башня|форт|особняк|большой дом|малый дом|дом|трущ[её]бы)(_|$| )/

function srCatalog() {
    var cat = {}
    try {
        global.TFG_BLUEPRINTS.names().forEach(n => {
            var name = String(n).replace(/ \(.*\)$/, "")
            // В поселение берём только свои постройки. Всё, что приехало из чужих схематик
            // (fortress, ffh2, medieval_*), годится для /tfgstruct, но не для деревни.
            if (!SR_OURS.test(name)) return
            var info = global.TFG_STRUCTURES.info(name)
            if (!info) return
            if (!cat[info.profile]) cat[info.profile] = []
            cat[info.profile].push(name)
        })
    } catch (e) { srErr("каталог шаблонов", e) }
    return cat
}

/**
 * Состав поселения. Правила хозяина:
 * особняк - не чаще одного на пять домов, большой дом - одного на три,
 * малых домов не меньше, чем обычных, башня всегда одна и стоит рядом с фортом.
 */
function srCompose(houses, have) {
    var out = []
    var mansions = have["особняк"] ? Math.floor(houses / 5) : 0
    var bigs = have["большой"] ? Math.floor(houses / 3) : 0
    var rest = Math.max(0, houses - mansions - bigs)
    var ordinary = have["малый"] ? Math.floor(rest / 2) : rest
    var smalls = rest - ordinary
    if (!have["дом"]) { smalls += ordinary; ordinary = 0 }
    if (!have["малый"]) { ordinary += smalls; smalls = 0 }

    // форт с башней у входа в поселение
    if (have["форт"] && houses >= 4) out.push({ type: "форт" })
    if (have["башня"]) out.push({ type: "башня" })
    for (var i = 0; i < mansions; i++) out.push({ type: "особняк" })
    for (var j = 0; j < bigs; j++) out.push({ type: "большой" })
    for (var k = 0; k < ordinary; k++) out.push({ type: "дом" })
    for (var l = 0; l < smalls; l++) out.push({ type: "малый" })
    // Трущобы - сверх домов: хибары бедноты. У них свой квартал - отдельные лучи (srBuild).
    var slums = have["трущобы"] ? Math.max(4, Math.min(SR_SLUM_MAX, Math.round(houses * 0.8))) : 0
    for (var m = 0; m < slums; m++) out.push({ type: "трущобы" })
    return out
}

// ─── Улица целиком ───────────────────────────────────────────────────────────

function srLoad() {
    // После /reload сервер здесь становится известен только с первого хода этого скрипта, а другие
    // скрипты спрашивают улицы раньше: чтение падало, и поселения считались стоящими без улиц.
    if (!SR_SERVER) { try { SR_SERVER = Utils.server } catch (e) { } }
    var pd = SR_SERVER.persistentData
    try { return JSON.parse(global.TFG_STORE.read(pd, "tfg_streets") || "{}") } catch (e) { return {} }
}

function srSave(data) {
    var bad = global.TFG_STORE.write(SR_SERVER.persistentData, "tfg_streets", JSON.stringify(data))
    if (bad) srErr("запись улиц", bad)
}

/**
 * Построить улицу рядом с точкой. houses - сколько домов (3 или 4).
 * Возвращает запись улицы или строку с ошибкой.
 */
// ─── Рельеф под дорожки ──────────────────────────────────────────────────────

const SR_STEP_UP = 2                // какой подъём тропа берёт в лоб
const SR_SPOKE_MAX = 50             // длина радиальной тропы
const SR_CHORD_AT = 200             // дальше этого соседние лучи связываем дугой
const SR_RING_GAP = 9               // от форта до кольца
const SR_DENSE = 0.6                // шаг домов вдоль луча в долях полуширины коробки: трущобы
const SR_SLUM_PER_SPOKE = 8         // хибар на один луч квартала трущоб (по 4 на сторону)
const SR_SLUM_MAX = 16              // больше хибар в одно поселение не ставим

function srTop(level, x, z) {
    try { return global.TFG_STRUCTURES.top(level, Math.round(x), Math.round(z)) } catch (e) { return 70 }
}

/** Что лежит на поверхности: по воде и по чужой кладке тропу не ведём. */
function srSurface(level, x, z, y) {
    try { return String(level.getBlock(Math.round(x), y, Math.round(z)).id) } catch (e) { return "" }
}

/**
 * Прогулка по рельефу. Идём в заданную сторону, но на каждом шаге выбираем из пяти
 * направлений самое пологое: камень обходим, с кручи спускаемся наискось. Если и так
 * не выходит - останавливаемся: пусть тропа будет короче, чем вкопанной в обрыв.
 */
function srWalk(level, x, z, ang, steps) {
    // Ни одна координата не должна стать "не числом": один NaN разъедает весь луч,
    // дома получают невалидное место и молча не ставятся (так и было в логе).
    if (!isFinite(x) || !isFinite(z) || !isFinite(ang)) {
        srErr("прогулка", "негодные исходные данные x=" + x + " z=" + z + " угол=" + ang)
        return [{ x: isFinite(x) ? x : 0, z: isFinite(z) ? z : 0 }]
    }
    var pts = [{ x: x, z: z }]
    var cx = x, cz = z, cy = srTop(level, x, z)
    for (var i = 0; i < steps; i++) {
        var best = null
        for (var d = -2; d <= 2; d++) {
            var a = ang + d * 0.22                                   // до 25 градусов в сторону
            var nx = cx + Math.cos(a) * 2, nz = cz + Math.sin(a) * 2
            var ny = srTop(level, nx, nz)
            var id = srSurface(level, nx, nz, ny)
            var climb = Math.abs(ny - cy)
            var cost = climb * 4 + Math.abs(d) * 1.5
            if (climb > SR_STEP_UP) cost += (climb - SR_STEP_UP) * 8   // круто - ищем пологий обход
            var wet = id.indexOf("water") >= 0 || id.indexOf("lava") >= 0
            if (wet) cost += 300
            if (srManMade(id)) cost += 80                              // чужая кладка
            if (!isFinite(nx) || !isFinite(nz) || !isFinite(ny) || !isFinite(cost)) continue
            if (best === null || cost < best.cost) best = { cost: cost, x: nx, z: nz, y: ny, a: a, wet: wet, climb: climb }
        }
        // Останавливаемся только там, где идти действительно некуда: вода, чужая стена
        // или отвес. Незнакомый грунт или бугор тропу не останавливают.
        if (!best || best.wet || best.climb > 6 || best.cost > 150) break
        ang = ang * 0.6 + best.a * 0.4                                 // доворачиваем плавно
        cx = best.x; cz = best.z; cy = best.y
        pts.push({ x: cx, z: cz })
    }
    return pts
}

// ─── Выглаживание округи ─────────────────────────────────────────────────────
//
// Перед стройкой вся площадь поселения сглаживается: каждый столб подводится к среднему
// рельефу вокруг него не дальше чем на SR_SMOOTH_TOL блоков. Пики срезаются, ямы, провалы
// и устья пещер засыпаются - жители больше не сваливаются в шахты. Вода и чужая кладка не
// трогаются. Каждый изменённый кусок 16x16 сперва снимается в зону: снос поселения
// возвращает рельеф каким был.

const SR_SMOOTH_R = 110             // радиус выглаживания от середины поселения: кольцо, лучи, поле, промзона
const SR_SMOOTH_WIN = 6             // полуокно среднего рельефа (окно 13x13)
const SR_SMOOTH_TOL = 2             // настолько пик может быть выше среднего рельефа
const SR_SMOOTH_PIT = 1             // а яма - ниже: из ямы глубже житель не выберется

const SR_CLEAR_MARGIN = 24          // лес вырубается и на столько блоков дальше выглаженной округи
const SR_CLEAR_TAGS = ["#minecraft:logs", "#minecraft:leaves", "#tfc:fallen_leaves", "#tfc:twigs"]

/**
 * Полная вырубка леса на месте поселения - до выглаживания: иначе выглаживание режет стволы по
 * высоте рельефа, и остаются пни, обрубки и висящие кроны. Плитками 16x16 от земли и на 70 блоков
 * вверх: брёвна, листва, опавшая листва и ветки - в воздух.
 */
function srClearTrees(level, cx, cz) {
    var dim = String(level.getDimension())
    var R = SR_SMOOTH_R + SR_CLEAR_MARGIN, n = 0
    for (var x0 = Math.floor((cx - R) / 16) * 16; x0 <= cx + R; x0 += 16) {
        for (var z0 = Math.floor((cz - R) / 16) * 16; z0 <= cz + R; z0 += 16) {
            var mx = x0 + 8 - cx, mz = z0 + 8 - cz
            if (mx * mx + mz * mz > (R + 12) * (R + 12)) continue
            var lo = 1e9
            ;[[0, 0], [15, 0], [0, 15], [15, 15], [8, 8]].forEach(q => {
                try { var h = Number(level.getHeight("OCEAN_FLOOR", x0 + q[0], z0 + q[1])); if (h < lo) lo = h } catch (e) { }
            })
            if (lo > 1e8) continue
            var y1 = lo - 6, y2 = lo + 70
            SR_CLEAR_TAGS.forEach(tag => {
                try {
                    SR_SERVER.runCommandSilent("execute in " + dim + " run fill " + x0 + " " + y1 + " " + z0 + " " + (x0 + 15) + " " + y2 + " " +
                        (z0 + 15) + " minecraft:air replace " + tag)
                } catch (e) { }
            })
            n++
        }
    }
    srLog("лес на месте поселения вырублен: плиток " + n + " (радиус " + R + ")")
}

// ─── Вода в черте поселения ──────────────────────────────────────────────────
//
// Жители падали в овраги с водой и не выбирались. Всякую воду в черте поселения закрываем сплошным
// слоем самана в два блока по её уровню. Каждый участок 16x16 с водой - своя зона отката: снос улицы
// возвращает воду. Незагруженные участки пропускаем - их доделает следующий проход (fillWater).

const SR_WATER_FILL = "tfc:mud_bricks/loam"
const SR_WATERS = ["minecraft:water", "tfc:salt_water", "tfc:spring_water", "tfc:river_water"]

/** done - участки, что уже пройдены ("x0,z0" -> 1). Вернёт { zones, skipped, cols }. */
const SR_WATER_ON = false             // засыпка воды выключена: саман мешал форту и оставался после отката

function srFillWater(level, cx, cz, owner, done) {
    if (!SR_WATER_ON) return { zones: [], skipped: 0, cols: 0 }
    var dim = String(level.getDimension())
    var R = SR_SMOOTH_R, zones = [], skipped = 0, cols = 0
    done = done || {}
    for (var x0 = Math.floor((cx - R) / 16) * 16; x0 <= cx + R; x0 += 16) {
        for (var z0 = Math.floor((cz - R) / 16) * 16; z0 <= cz + R; z0 += 16) {
            var key = x0 + "," + z0
            if (done[key]) continue
            var mx = x0 + 8 - cx, mz = z0 + 8 - cz
            if (mx * mx + mz * mz > (R + 12) * (R + 12)) { done[key] = 1; continue }
            var loaded = false
            try { loaded = !!level.hasChunk(x0 >> 4, z0 >> 4) } catch (e) { }
            if (!loaded) { skipped++; continue }
            var levels = {}
            for (var i = 0; i < 16; i++) {
                for (var j = 0; j < 16; j++) {
                    var x = x0 + i, z = z0 + j
                    if ((x - cx) * (x - cx) + (z - cz) * (z - cz) > R * R) continue
                    var ws = 0
                    try { ws = Number(level.getHeight("WORLD_SURFACE", x, z)) } catch (e) { continue }
                    var id = ""
                    try { id = String(level.getBlock(x, ws - 1, z).id) } catch (e) { continue }
                    if (id.indexOf("water") < 0) continue
                    levels[ws - 1] = 1
                    cols++
                }
            }
            done[key] = 1
            var ys = Object.keys(levels).map(Number)
            if (!ys.length) continue
            var lo = Math.min.apply(null, ys) - 1, hi = Math.max.apply(null, ys)
            var zone = global.TFG_ZONES.snapshot(level, x0, lo, z0, x0 + 15, hi, z0 + 15, { label: "засыпка воды", owner: owner || null })
            if (String(zone).indexOf("z") !== 0) { srErr("засыпка воды " + key, zone); continue }
            zones.push(zone)
            ys.forEach(y => SR_WATERS.forEach(w => {
                try {
                    SR_SERVER.runCommandSilent("execute in " + dim + " run fill " + x0 + " " + (y - 1) + " " + z0 + " " +
                        (x0 + 15) + " " + y + " " + (z0 + 15) + " " + SR_WATER_FILL + " replace " + w)
                } catch (e) { }
            }))
        }
    }
    if (cols) srLog("вода в черте поселения закрыта саманом: столбцов " + cols + ", зон " + zones.length + (skipped ? ", не прогружено участков " + skipped : ""))
    return { zones: zones, skipped: skipped, cols: cols }
}

/** Засыпать воду у уже стоящей улицы (старые поселения). true - вся черта пройдена. */
function srFillWaterStreet(level, id) {
    var data = srLoad()
    var rec = data[id]
    if (!rec) return true
    rec.waterDone = rec.waterDone || {}
    var res = srFillWater(level, rec.x, rec.z, rec.owner, rec.waterDone)
    rec.zones = (rec.zones || []).concat(res.zones)
    srSave(data)
    return res.skipped === 0
}

/**
 * Ничьи зоны рельефа: их оставляли стройки, у которых не встал форт (до правки - по сотне за круг).
 * /tfgorphans - сколько; /tfgorphans drop - забыть (земля остаётся выглаженной);
 * /tfgorphans restore - откатить землю к дикой. Только когда ничего не строится.
 */
function srOrphans() {
    var used = {}
    var data = srLoad()
    for (var id in data) (data[id].zones || []).forEach(z => { used[z] = 1 })
    return global.TFG_ZONES.list().filter(z => (z.label === "поселение рельеф" || z.label === "засыпка воды") && !used[z.id])
}

ServerEvents.commandRegistry(event => {
    var Commands = event.commands
    var run = (ctx, how) => {
        if (SR_QUEUE.length || global.TFG_ZONES.busy()) { ctx.source.sendFailure(Text.of("Сейчас идёт стройка или откат - дождитесь.")); return 0 }
        var list = srOrphans()
        if (how === "drop") list.forEach(z => global.TFG_ZONES.drop(z.id))
        if (how === "restore") list.forEach(z => global.TFG_ZONES.restore(z.id, "ничья зона рельефа"))
        ctx.source.sendSuccess(Text.of("Ничьих зон рельефа: " + list.length + (how ? (how === "drop" ? " - забыты" : " - откатываются") : "")), false)
        srLog("ничьи зоны рельефа: " + list.length + (how ? ", " + how : ""))
        return 1
    }
    event.register(Commands.literal("tfgorphans").requires(s => s.hasPermission(2))
        .executes(ctx => run(ctx, null))
        .then(Commands.literal("drop").executes(ctx => run(ctx, "drop")))
        .then(Commands.literal("restore").executes(ctx => run(ctx, "restore"))))
})

// ─── Разведка площадки под форт ──────────────────────────────────────────────

const SR_PRE_HALF = 18                // полуширина пятна форта с запасом
const SR_PRE_R = 96                   // как далеко от записи можно сдвинуть середину поселения
const SR_PRE_RANGE = 12               // перепад, который выглаживание ещё выровняет

/** Годится ли точка под форт на нетронутой земле: null - да, иначе причина. */
function srPreOk(level, px, pz) {
    px = Number(px); pz = Number(pz)
    if (!isFinite(px) || !isFinite(pz)) return "не число"
    var half = Number(SR_PRE_HALF) || 18
    try { if (stZoneClash(level, px, pz, half, null)) { SR_PRE_CLASH[ST_CLASH] = (SR_PRE_CLASH[ST_CLASH] || 0) + 1; return "занято" } } catch (e) { }
    var lo = 1e9, hi = -1e9
    for (var ddx = -half; ddx <= half; ddx += 3) {
        for (var ddz = -half; ddz <= half; ddz += 3) {
            var top = stTop(level, px + ddx, pz + ddz)
            var bid = ""
            try { bid = String(level.getBlock(px + ddx, top, pz + ddz).id) } catch (e) { return "не прогружено" }
            if (bid.indexOf("water") >= 0 || bid.indexOf("lava") >= 0 || bid.indexOf("ice") >= 0) return "вода"
            if (srManMade(bid) && bid.indexOf("mud_bricks") < 0) return "чужая кладка"
            if (top < lo) lo = top
            if (top > hi) hi = top
        }
    }
    if (hi - lo > SR_PRE_RANGE) return "склон"
    return null
}

/** Ближайшая годная площадка: { ok, x, z } или { ok: false, why: "вода 40, склон 12" }. */
var SR_PRE_CLASH = {}                 // какие зоны держали место (для лога)

function srPreflight(level, cx, cz) {
    // Без стрелочных функций и общих имён переменных: в Rhino сервера разведка путала координаты, и любое
    // место «налетало» на первую зону реестра за тысячи блоков отсюда.
    var ox = Math.floor(Number(cx)), oz = Math.floor(Number(cz))
    var why = {}
    SR_PRE_CLASH = {}
    var cand = [[ox, oz]]
    for (var ring = 6; ring <= SR_PRE_R; ring += 6) {
        for (var step = 0; step < 16; step++) {
            var ang = step * 3.141592653589793 / 8 + ((ring % 12) ? 3.141592653589793 / 16 : 0)
            cand.push([Math.floor(ox + Math.cos(ang) * ring), Math.floor(oz + Math.sin(ang) * ring)])
        }
    }
    var firstBad = null
    for (var ci = 0; ci < cand.length; ci++) {
        var qx = cand[ci][0], qz = cand[ci][1]
        var res = srPreOk(level, qx, qz)
        if (!res) return { ok: true, x: qx, z: qz }
        why[res] = (why[res] || 0) + 1
        if (!firstBad && res === "занято") firstBad = qx + " " + qz
    }
    var txt = Object.keys(why).map(k => k + " " + why[k]).join(", ")
    srLog("разведка у " + ox + " " + oz + ": площадки под форт нет (" + txt + ")" + (Object.keys(SR_PRE_CLASH).length ? "; мешают зоны: " +
        Object.keys(SR_PRE_CLASH).slice(0, 6).map(k => k + " x" + SR_PRE_CLASH[k]).join("; ") + "; первое занятое место " + firstBad : ""))
    return { ok: false, why: txt }
}

// ─── Починка округи после неудачной или старой стройки ───────────────────────
//
// /tfgrepair <радиус> (оператор): в радиусе от игрока - саман засыпки обратно в воду, тропы (tfc:grass_path)
// обратно в траву той же почвы, и на голой траве - лес породами округи (place feature tfc:tree/<порода>).
// Внутри живого поселения не работает. Идёт очередью по тикам.

var SR_REPAIR = []                    // очередь команд починки

const SR_REPAIR_KEEP = 130            // черта живого поселения: её починка не трогает

function srRepair(level, cx, cz, R) {
    var dim = String(level.getDimension())
    var cmds = []
    // живые поселения рядом: их участки и тропы обходим
    var live = []
    try { var dd = srLoad(); for (var sid in dd) live.push(dd[sid]) } catch (e) { }
    var inLive = (x, z, pad) => live.some(st => Math.pow(st.x - x, 2) + Math.pow(st.z - z, 2) < Math.pow(SR_REPAIR_KEEP + (pad || 0), 2))
    var skipped = 0
    for (var x0 = Math.floor((cx - R) / 16) * 16; x0 <= cx + R; x0 += 16) {
        for (var z0 = Math.floor((cz - R) / 16) * 16; z0 <= cz + R; z0 += 16) {
            var mx = x0 + 8 - cx, mz = z0 + 8 - cz
            if (mx * mx + mz * mz > (R + 12) * (R + 12)) continue
            if (inLive(x0 + 8, z0 + 8, 12)) { skipped++; continue }
            try { if (!level.hasChunk(x0 >> 4, z0 >> 4)) continue } catch (e) { continue }
            var lo = 1e9, hi = -1e9
            ;[[0, 0], [15, 0], [0, 15], [15, 15], [8, 8]].forEach(q => {
                try { var h = Number(level.getHeight("WORLD_SURFACE", x0 + q[0], z0 + q[1])); if (h < lo) lo = h; if (h > hi) hi = h } catch (e) { }
            })
            if (lo > 1e8) continue
            var y1 = lo - 6, y2 = hi + 4
            var box = x0 + " " + y1 + " " + z0 + " " + (x0 + 15) + " " + y2 + " " + (z0 + 15)
            cmds.push("execute in " + dim + " run fill " + box + " minecraft:water replace tfc:mud_bricks/loam")
            SR_PATH_SOILS.forEach(soil => cmds.push("execute in " + dim + " run fill " + box + " tfc:grass/" + soil + " replace tfc:grass_path/" + soil))
        }
    }
    // лес: породы округи, на голой траве, примерно дерево на 80 клеток
    var woods = []
    try { woods = srRegionTrees(level, cx, cz) } catch (e) { }
    if (!woods.length) woods = ["oak", "birch"]
    var trees = 0
    for (var i = 0; i < Math.floor(3.141592653589793 * R * R / 80); i++) {
        var r = Math.sqrt(Math.random()) * R, a = Math.random() * 3.141592653589793 * 2
        var x = Math.floor(cx + Math.cos(a) * r), z = Math.floor(cz + Math.sin(a) * r)
        if (inLive(x, z, 0)) continue
        var t = stTop(level, x, z)
        var id = ""
        try { id = String(level.getBlock(x, t, z).id) } catch (e) { continue }
        if (id.indexOf("tfc:grass/") !== 0 && id.indexOf("tfc:grass_path/") !== 0) continue
        cmds.push("execute in " + dim + " run place feature tfc:tree/" + woods[Math.floor(Math.random() * woods.length)] + " " + x + " " + (t + 1) + " " + z)
        trees++
    }
    SR_REPAIR = SR_REPAIR.concat(cmds)
    srLog("починка округи " + cx + " " + cz + " (радиус " + R + "): команд " + cmds.length + ", деревьев " + trees + " (" + woods.join(", ") + ")" +
        (skipped ? ", участков в черте живых поселений обойдено " + skipped : ""))
    return { cmds: cmds.length, trees: trees, woods: woods, skipped: skipped }
}

ServerEvents.tick(event => {
    if (!SR_REPAIR.length) return
    // тропы и лес - поверх уже вернувшейся земли: пока идёт откат зон, ждём
    try { if (global.TFG_ZONES.busy()) return } catch (e) { }
    for (var n = 0; n < 4 && SR_REPAIR.length; n++) {
        try { event.server.runCommandSilent(SR_REPAIR.shift()) } catch (e) { }
    }
})

ServerEvents.commandRegistry(event => {
    var Commands = event.commands, Arguments = event.arguments
    event.register(Commands.literal("tfgrepair").requires(src => src.hasPermission(2))
        // засыпку воды саманом (36.2) - вернуть водой из её слепков во всех поселениях и ничьих зонах
        .then(Commands.literal("unfill").executes(ctx => {
            var data = srLoad(), n = 0, used = {}
            for (var id in data) {
                var rec = data[id]
                rec.zones = (rec.zones || []).filter(zid => {
                    var z = global.TFG_ZONES.get(zid)
                    if (!z || String(z.label) !== "засыпка воды") return true
                    global.TFG_ZONES.restore(zid, "вода обратно"); n++
                    return false
                })
                ;(rec.zones || []).forEach(zid => { used[zid] = 1 })
            }
            global.TFG_ZONES.list().forEach(z => { if (String(z.label) === "засыпка воды" && !used[z.id]) { global.TFG_ZONES.restore(z.id, "вода обратно"); n++ } })
            srSave(data)
            ctx.source.sendSuccess(Text.of("Засыпка саманом откатывается: зон " + n + ". Вода вернётся как была."), false)
            srLog("засыпка воды откатывается: зон " + n)
            return 1
        }))
        .then(Commands.argument("radius", Arguments.INTEGER.create(event)).executes(ctx => {
            var p = ctx.source.getPlayerOrException()
            var R = Math.max(16, Math.min(200, Number(Arguments.INTEGER.getResult(ctx, "radius"))))
            var res = srRepair(p.level, Math.floor(p.x), Math.floor(p.z), R)
            ctx.source.sendSuccess(Text.of("Чиню округу в радиусе " + R + ": саман - в воду, тропы - в траву, деревьев " + res.trees +
                " (" + res.woods.join(", ") + "). Команд " + res.cmds + ", идёт очередью." +
                (res.skipped ? " Черту живых поселений рядом обхожу (участков " + res.skipped + ")." : "")), false)
            return 1
        })))
})

function srSmooth(level, cx, cz, owner) {
    var R = SR_SMOOTH_R, W = SR_SMOOTH_WIN
    var ox = Math.floor(cx) - R - W, oz = Math.floor(cz) - R - W
    var n = 2 * (R + W) + 1
    var H = [], OK = []
    // саман засыпанной воды выглаживаем вместе с землёй, иначе на месте пруда остаётся яма или ступень
    var natural = id => { if (String(id).indexOf("mud_bricks") >= 0) return true; try { return !!global.TFG_STRUCTURES.natural(id) } catch (e) { return true } }
    for (var i = 0; i < n; i++) {
        for (var j = 0; j < n; j++) {
            var x = ox + i, z = oz + j, k = i * n + j
            var loaded = true
            try { loaded = !!level.hasChunk(x >> 4, z >> 4) } catch (e) { }
            if (!loaded) { OK[k] = false; H[k] = 0; continue }
            var h = srTop(level, x, z)
            var id = srSurface(level, x, z, h)
            H[k] = h
            OK[k] = !!id && id.indexOf("water") < 0 && id.indexOf("lava") < 0 && id.indexOf("ice") < 0 && natural(id)
        }
    }
    // суммы по префиксу: средний рельеф окна считается за четыре обращения
    var S = [], C = []
    for (var z0 = 0; z0 < (n + 1) * (n + 1); z0++) { S[z0] = 0; C[z0] = 0 }
    for (var a = 0; a < n; a++) {
        for (var b = 0; b < n; b++) {
            var p = (a + 1) * (n + 1) + (b + 1), q = a * n + b
            S[p] = S[p - 1] + S[p - (n + 1)] - S[p - (n + 1) - 1] + (OK[q] ? H[q] : 0)
            C[p] = C[p - 1] + C[p - (n + 1)] - C[p - (n + 1) - 1] + (OK[q] ? 1 : 0)
        }
    }
    var rect = (arr, a1, b1, a2, b2) => arr[(a2 + 1) * (n + 1) + (b2 + 1)] - arr[a1 * (n + 1) + (b2 + 1)] -
        arr[(a2 + 1) * (n + 1) + b1] + arr[a1 * (n + 1) + b1]
    // Цель: средний рельеф окна (рябь и выбросы уходят целиком), затем полировка - соседние
    // клетки нигде не расходятся больше чем на блок. Сперва срезаем то, что выше соседа на
    // два и больше, потом подсыпаем то, что ниже: по такой земле жители ходят без прыжков.
    // Столбы за краем круга не меняются и служат опорой: к ним рельеф подводится плавно.
    var T = [], IN = []
    for (var i2 = 0; i2 < n; i2++) {
        for (var j2 = 0; j2 < n; j2++) {
            var k2 = i2 * n + j2
            var dx = i2 - R - W, dz = j2 - R - W
            IN[k2] = false
            T[k2] = OK[k2] ? H[k2] : null
            if (!OK[k2] || i2 < W || j2 < W || i2 >= n - W || j2 >= n - W || dx * dx + dz * dz > R * R) continue
            var cnt = rect(C, i2 - W, j2 - W, i2 + W, j2 + W)
            if (cnt < 20) continue
            T[k2] = Math.round(rect(S, i2 - W, j2 - W, i2 + W, j2 + W) / cnt)
            IN[k2] = true
        }
    }
    var relax = (cut) => {
        for (var pass = 0; pass < 2; pass++) {
            var fwd = pass === 0
            for (var a = fwd ? 0 : n - 1; fwd ? a < n : a >= 0; a += fwd ? 1 : -1) {
                for (var b = fwd ? 0 : n - 1; fwd ? b < n : b >= 0; b += fwd ? 1 : -1) {
                    var k = a * n + b
                    if (!IN[k]) continue
                    for (var da = -1; da <= 1; da++) {
                        for (var db = -1; db <= 1; db++) {
                            if (!da && !db) continue
                            var na = a + da, nb = b + db
                            if (na < 0 || nb < 0 || na >= n || nb >= n) continue
                            var tn = T[na * n + nb]
                            if (tn === null) continue
                            if (cut && T[k] > tn + 1) T[k] = tn + 1
                            if (!cut && T[k] < tn - 1) T[k] = tn - 1
                        }
                    }
                }
            }
        }
    }
    relax(true)
    relax(false)
    // Рябь в блок-два: одиночный бугорок или ямка (клетка выше или ниже шести соседей из восьми)
    // ровняется по середине соседей - на ровном месте не должно быть кочек и впадин.
    for (var sp = 0; sp < 3; sp++) {
        for (var a3 = 1; a3 < n - 1; a3++) {
            for (var b3 = 1; b3 < n - 1; b3++) {
                var k4 = a3 * n + b3
                if (!IN[k4]) continue
                var nb = []
                for (var da3 = -1; da3 <= 1; da3++) for (var db3 = -1; db3 <= 1; db3++) {
                    if (!da3 && !db3) continue
                    var tv = T[(a3 + da3) * n + b3 + db3]
                    if (tv !== null) nb.push(tv)
                }
                if (nb.length < 6) continue
                var hiN = nb.filter(t => t > T[k4]).length, loN = nb.filter(t => t < T[k4]).length
                if (hiN >= 6 || loN >= 6) { nb.sort((x, y) => x - y); T[k4] = nb[Math.floor(nb.length / 2)] }
            }
        }
    }
    var tiles = {}, changes = 0
    for (var k3 = 0; k3 < n * n; k3++) {
        if (!IN[k3] || T[k3] === H[k3]) continue
        var wx = ox + Math.floor(k3 / n), wz = oz + (k3 % n)
        var tk = Math.floor(wx / 16) + "," + Math.floor(wz / 16)
        ;(tiles[tk] = tiles[tk] || []).push({ x: wx, z: wz, h: H[k3], t: T[k3] })
        changes++
    }    var zones = []
    for (var tk2 in tiles) {
        var list = tiles[tk2]
        var lo = 1e9, hi = -1e9
        list.forEach(c => {
            c.top = c.h
            try { c.top = Math.max(c.h, Number(level.getHeight("WORLD_SURFACE", c.x, c.z)) - 1) } catch (e) { }
            lo = Math.min(lo, c.h, c.t)
            hi = Math.max(hi, c.top, c.t)
        })
        var tp = tk2.split(","), tx1 = Number(tp[0]) * 16, tz1 = Number(tp[1]) * 16
        var zid = global.TFG_ZONES.snapshot(level, tx1, lo - 1, tz1, tx1 + 15, hi + 1, tz1 + 15,
            { label: "поселение рельеф", owner: owner || null })
        if (String(zid).indexOf("z") !== 0) { srLog("рельеф: кусок " + tk2 + " не снят (" + zid + ") - не трогаю"); continue }
        zones.push(zid)
        var dim = String(level.getDimension())
        list.forEach(c => {
            var surf = srSurface(level, c.x, c.z, c.h)
            if (surf.indexOf("grass") < 0 && surf.indexOf("dirt") < 0 && surf.indexOf("sand") < 0) surf = ""
            if (c.t < c.h) {
                // пик: срезаем столб вместе с тем, что на нём росло
                SR_SERVER.runCommandSilent("execute in " + dim + " run fill " + c.x + " " + (c.t + 1) + " " + c.z + " " +
                    c.x + " " + c.top + " " + c.z + " minecraft:air replace")
            } else {
                // яма: засыпаем местным грунтом до нужной высоты
                var g = "tfc:dirt/loam"
                try { g = String(global.TFG_STRUCTURES.groundState(level, c.x, c.z)) } catch (e) { }
                SR_SERVER.runCommandSilent("execute in " + dim + " run fill " + c.x + " " + (c.h + 1) + " " + c.z + " " +
                    c.x + " " + c.t + " " + c.z + " " + g + " replace")
            }
            if (surf) SR_SERVER.runCommandSilent("execute in " + dim + " run setblock " + c.x + " " + c.t + " " + c.z + " " + surf + " replace")
        })
    }
    srLog("рельеф выглажен: столбов " + changes + ", кусков " + zones.length)
    return zones
}

// ─── Земля поселения: деревья округи, пустырь, грязь ─────────────────────────

const SR_TREE_STEP = 7              // шаг сетки посадки (с разбросом)
const SR_TREE_CHANCE = 0.5          // доля клеток сетки, где встаёт дерево
const SR_TREE_MAX = 140
const SR_LANDING_R = 15             // пустырь под дирижабли: радиус
const SR_MUD_EDGE = 0.85            // у троп и стен грязь почти сплошь
const SR_MUD_SHARE = 0.5           // доля свободной земли поселения под грязью

/** Какие деревья растут в округе: по брёвнам под кронами за пределами будущего поселения. */
function srRegionTrees(level, cx, cz) {
    var count = {}
    for (var t = 0; t < 400; t++) {
        var r = 60 + Math.random() * 160, a = Math.random() * 6.283185307179586
        var x = Math.floor(cx + Math.cos(a) * r), z = Math.floor(cz + Math.sin(a) * r)
        try { if (!level.hasChunk(x >> 4, z >> 4)) continue } catch (e) { continue }
        var h = 0
        try { h = Number(level.getHeight("MOTION_BLOCKING", x, z)) } catch (e) { continue }
        if (srSurface(level, x, z, h - 1).indexOf("leaves") < 0) continue
        for (var y = h - 2; y > h - 24; y--) {
            var m = srSurface(level, x, z, y).match(/^tfc:wood\/(log|wood)\/([a-z_]+)$/)
            if (m) { count[m[2]] = (count[m[2]] || 0) + 1; break }
        }
    }
    var list = Object.keys(count).filter(k => count[k] >= 3).sort((p, q) => count[q] - count[p]).slice(0, 3)
    srLog("деревья округи: " + (list.length ? list.map(k => k + " " + count[k]).join(", ") : "нет - степь, сажать нечего"))
    return list
}

/** Почва клетки для грязи: tfc:mud/<почва> - той же почвы, что трава под ней. */
function srSoilAt(level, x, z) {
    var m = srSurface(level, x, z, srTop(level, x, z)).match(/(silty_loam|sandy_loam|loam|silt)$/)
    return m ? m[1] : "loam"
}

/** Команда по верхнему блоку клетки в момент исполнения (рельеф к тому времени уже переделан). */
function srOnTop(dim, x, z, test, run) {
    return "execute in " + dim + " positioned " + x + " 0 " + z + " positioned over motion_blocking_no_leaves if block ~ ~-1 ~ " +
        test + " run " + run
}

/**
 * ctx: { fx, fz, ringR, placed, paved, pathCells, cmds, angles, trees }.
 * Пустырь у крепости - в самом широком промежутке между лучами и дорогой. Деревья - на свободной
 * земле (не тропа, не постройка с отступом, не пустырь). Грязь - пятнами вдоль троп и вокруг домов.
 */
function srDress(level, ctx) {
    var dim = String(level.getDimension())
    var R = SR_SMOOTH_R
    var TAU = 6.283185307179586
    // пустырь: середина самого широкого промежутка между лучами, дорогой и башней
    var angs = ctx.angles.filter(a => isFinite(a)).map(a => ((a % TAU) + TAU) % TAU).sort((p, q) => p - q)
    var gapA = 0, gapW = -1
    for (var i = 0; i < angs.length; i++) {
        var a1 = angs[i], a2 = i + 1 < angs.length ? angs[i + 1] : angs[0] + TAU
        if (a2 - a1 > gapW) { gapW = a2 - a1; gapA = (a1 + a2) / 2 }
    }
    var lr = ctx.ringR + SR_LANDING_R + 6
    var landing = { x: Math.round(ctx.fx + Math.cos(gapA) * lr), z: Math.round(ctx.fz + Math.sin(gapA) * lr), r: SR_LANDING_R }
    var inLanding = (x, z) => (x - landing.x) * (x - landing.x) + (z - landing.z) * (z - landing.z) <= (landing.r + 3) * (landing.r + 3)
    var inBox = (x, z, pad) => ctx.placed.some(b => x >= b.x - pad && x < b.x + b.size[0] + pad && z >= b.z - pad && z < b.z + b.size[2] + pad)
    var nearPath = (x, z, d) => {
        for (var dx = -d; dx <= d; dx++) for (var dz = -d; dz <= d; dz++) if (ctx.paved[(x + dx) + "," + (z + dz)]) return true
        return false
    }

    // Грязь: средневековая улица - утоптанная грязь занимает половину свободной земли поселения.
    // У троп и стен домов почти сплошь, дальше - пятнами разного размера с рваным краем.
    var freeSet = {}, freeList = []
    for (var fx0 = -R; fx0 <= R; fx0++) {
        for (var fz0 = -R; fz0 <= R; fz0++) {
            if (fx0 * fx0 + fz0 * fz0 > R * R) continue
            var cx0 = Math.round(ctx.fx) + fx0, cz0 = Math.round(ctx.fz) + fz0, ck = cx0 + "," + cz0
            if (ctx.paved[ck] || inLanding(cx0, cz0) || inBox(cx0, cz0, 0)) continue
            freeSet[ck] = 1
            freeList.push([cx0, cz0])
        }
    }
    var mudSeen = {}, mud = []
    var addMud = (x, z, chance) => {
        var k = x + "," + z
        if (mudSeen[k] || !freeSet[k] || Math.random() > chance) return
        mudSeen[k] = 1
        mud.push([x, z])
    }
    // полоса у троп и вокруг домов
    ctx.pathCells.forEach(c => {
        for (var dx = -2; dx <= 2; dx++) for (var dz = -2; dz <= 2; dz++) addMud(c[0] + dx, c[1] + dz, SR_MUD_EDGE)
    })
    ctx.placed.forEach(b => {
        if (b.type === "форт" || b.type === "башня") return
        for (var x = b.x - 2; x < b.x + b.size[0] + 2; x++) {
            for (var z = b.z - 2; z < b.z + b.size[2] + 2; z++) addMud(x, z, SR_MUD_EDGE)
        }
    })
    // пятна, пока грязь не займёт свою долю свободной земли
    var target = Math.floor(freeList.length * SR_MUD_SHARE)
    for (var tr = 0; tr < 6000 && mud.length < target && freeList.length; tr++) {
        var c0 = freeList[Math.floor(Math.random() * freeList.length)]
        // у троп пятна чаще, на отшибе реже
        if (!nearPath(c0[0], c0[1], 8) && Math.random() < 0.6) continue
        var pr = 2 + Math.random() * 5
        for (var px = -7; px <= 7; px++) {
            for (var pz = -7; pz <= 7; pz++) {
                var edge = pr * (0.7 + Math.random() * 0.3)
                if (px * px + pz * pz <= edge * edge) addMud(c0[0] + px, c0[1] + pz, 1)
            }
        }
    }
    // полосами вдоль z одной командой: fill меняет только траву (#tfc:grass) - полы и камень не тронет
    var byX = {}
    mud.forEach(c => { (byX[c[0]] = byX[c[0]] || []).push(c[1]) })
    var soil = {}
    for (var mx in byX) {
        var zs = byX[mx].sort((p1, p2) => p1 - p2)
        var x1 = Number(mx)
        for (var s = 0; s < zs.length;) {
            var e = s
            while (e + 1 < zs.length && zs[e + 1] === zs[e] + 1 && e - s < 31) e++
            var lo = 1e9, hi = -1e9
            for (var q = s; q <= e; q++) { var hq = srTop(level, x1, zs[q]); if (hq < lo) lo = hq; if (hq > hi) hi = hq }
            var tk = (x1 >> 3) + "," + (zs[s] >> 3)
            if (!soil[tk]) soil[tk] = srSoilAt(level, x1, zs[s])
            ctx.cmds.push("execute in " + dim + " run fill " + x1 + " " + (lo - 3) + " " + zs[s] + " " + x1 + " " + (hi + 3) + " " + zs[e] +
                " tfc:mud/" + soil[tk] + " replace #tfc:grass")
            s = e + 1
        }
    }

    // деревья округи на свободной земле
    var trees = []
    if (ctx.trees.length) {
        for (var gx = -R; gx <= R && trees.length < SR_TREE_MAX; gx += SR_TREE_STEP) {
            for (var gz = -R; gz <= R && trees.length < SR_TREE_MAX; gz += SR_TREE_STEP) {
                if (gx * gx + gz * gz > R * R || Math.random() > SR_TREE_CHANCE) continue
                var tx = Math.round(ctx.fx + gx + (Math.random() - 0.5) * 4), tz = Math.round(ctx.fz + gz + (Math.random() - 0.5) * 4)
                var fd = (tx - ctx.fx) * (tx - ctx.fx) + (tz - ctx.fz) * (tz - ctx.fz)
                if (fd < (ctx.ringR + 4) * (ctx.ringR + 4)) continue           // в кольце у крепости - не сажаем
                if (inLanding(tx, tz) || inBox(tx, tz, 6) || nearPath(tx, tz, 3) || mudSeen[tx + "," + tz]) continue
                var sp = ctx.trees[Math.floor(Math.random() * ctx.trees.length)]
                ctx.cmds.push(srOnTop(dim, tx, tz, "#tfc:grass", "place feature tfc:tree/" + sp + " ~ ~ ~"))
                trees.push([tx, tz])
            }
        }
    }
    srLog("земля: пустырь у крепости " + landing.x + " " + landing.z + ", деревьев " + trees.length + ", грязи " + mud.length)
    return { landing: landing, trees: trees, mud: mud }
}

/** Кольцо вокруг форта: окружность ложится по рельефу клетка за клеткой. */
function srRing(cx, cz, r) {
    var pts = []
    var n = Math.max(32, Math.round(6.283185307179586 * r / 2))
    for (var i = 0; i <= n; i++) {
        var a = i / n * 6.283185307179586
        pts.push({ x: cx + Math.cos(a) * r, z: cz + Math.sin(a) * r })
    }
    return pts
}

/** Дуга кольца между двумя углами - ею связываем разошедшиеся лучи. */
function srArc(cx, cz, r, a1, a2) {
    var pts = []
    var da = a2 - a1
    while (da > 3.141592653589793) da -= 6.283185307179586
    while (da < -3.141592653589793) da += 6.283185307179586
    var n = Math.max(8, Math.round(Math.abs(da) * r / 2))
    for (var i = 0; i <= n; i++) {
        var a = a1 + da * i / n
        pts.push({ x: cx + Math.cos(a) * r, z: cz + Math.sin(a) * r })
    }
    return pts
}

// ─── Поселение ───────────────────────────────────────────────────────────────

/**
 * Радиально-квартальное поселение.
 *
 *   форт в середине -> кольцевая тропа вокруг него -> из кольца в разные стороны короткие лучи;
 *   дома стоят вдоль лучей, башня - сразу за кольцом у выезда, главная дорога уходит от ворот форта.
 *   Если концы соседних лучей разошлись больше чем на 200 блоков, связываем их дугой по кольцу.
 *
 * Всё приблизительно и по рельефу: тропы обходят камень и ищут пологий спуск.
 */
function srBuild(level, cx, cz, houses, owner, opts) {
    opts = opts || {}
    if (!SR_SERVER) SR_SERVER = level.getServer()
    houses = Math.max(2, Math.min(20, houses || (3 + Math.floor(Math.random() * 2))))
    var have = srCatalog()
    if (!have["дом"] && !have["малый"] && !have["большой"] && !have["особняк"]) {
        // Пустой каталог почти всегда значит не "нет шаблонов", а "соседний файл не загрузился".
        var why = ""
        try { why = global.TFG_BLUEPRINTS.names().length + " шаблонов в памяти" }
        catch (e) { why = "blueprints.js не загрузился" }
        try { global.TFG_STRUCTURES.info("форт") } catch (e2) { why += ", structures.js не загрузился" }
        return "нет ни одного шаблона жилья (" + why + ")"
    }
    if (!have["форт"]) return "нет шаблона форта - без него поселение не ставится"
    if (!have["башня"]) return "нет шаблона башни - без неё поселение не ставится"

    // Камень у поселения один. Если поселение пришло из реестра мира (factions/world.js),
    // берём породу той области, где оно стоит, а не случайную.
    var stone = opts.stone || srPick(global.TFG_STRUCTURES.rocks)
    try { if (opts.stone && global.TFG_STRUCTURES.rocks.indexOf(opts.stone) < 0) stone = srPick(global.TFG_STRUCTURES.rocks) } catch (e) { }
    var plan = srCompose(houses, have)
    var skipped = []

    // из каждой колоды тянем без возврата: соседи не должны совпасть ни деревом, ни металлом
    var srDeck = list => {
        var pool = list.slice()
        return () => {
            if (!pool.length) pool = list.slice()
            return pool.splice(Math.floor(Math.random() * pool.length), 1)[0]
        }
    }
    // Общность поселения: у деревни своя небольшая палитра - три породы дерева, два металла,
    // три цвета витражей. Дома разные, но видно, что построены одними руками и в одно время.
    var srSome = (list, n) => {
        var pool = list.slice(), out = []
        while (out.length < n && pool.length) out.push(pool.splice(Math.floor(Math.random() * pool.length), 1)[0])
        return out
    }
    var woodSet = srSome(global.TFG_STRUCTURES.woods, 3)
    var metalSet = srSome(global.TFG_STRUCTURES.decoMetals, 2)
    var glassSet = srSome(global.TFG_STRUCTURES.glassColors, 3)
    var wealth = Math.floor(Math.random() * 3)          // достаток: от него зависит, что на складах
    var mainCraft = srPick(SR_TRADES)                   // чем живёт округа
    var takeWood = srDeck(woodSet)
    var takeMetal = srDeck(metalSet)
    var takeGlass = srDeck(glassSet)
    var tradeN = 0

    var cmds = [], paved = {}, zones = [], placed = []
    var pathMat = "@дёрн"
    // сперва выглаживаем всю округу: постройки и тропы считают высоты уже по ровной земле
    // породы деревьев округи - пока рельеф не тронут (после выглаживания их тут уже не найти)
    // Разведка ДО вырубки и выглаживания: есть ли рядом площадка под форт (без воды, чужих построек
    // и обрывов). Нет - стройку отменяем, ничего не тронув: вырубку леса не откатить. Есть - середина
    // поселения встаёт на неё. Раньше место искали после выглаживания, и при неудаче лес был уже сведён.
    // пока идёт откат зон, старые слепки ещё числятся занятыми, а земля - наполовину прежней
    try { if (global.TFG_ZONES.busy()) return "идёт откат зон - дождитесь его конца (строки «возвращена как была» в логе)" } catch (e) { }
    var pre = srPreflight(level, Math.floor(cx), Math.floor(cz))
    if (!pre.ok) return "для форта нет места в " + SR_PRE_R + " блоках (" + pre.why + ") - ничего не тронуто"
    if (pre.x !== Math.floor(cx) || pre.z !== Math.floor(cz)) srLog("середина поселения сдвинута на площадку форта: " + pre.x + " " + pre.z)
    cx = pre.x; cz = pre.z
    var regionTrees = []
    try { regionTrees = srRegionTrees(level, cx, cz) } catch (e) { srErr("деревья округи", e) }
    try { srClearTrees(level, cx, cz) } catch (e) { srErr("вырубка", e) }
    var waterDone = {}
    try { zones = zones.concat(srFillWater(level, cx, cz, owner, waterDone).zones) } catch (e) { srErr("засыпка воды", e) }
    try { zones = zones.concat(srSmooth(level, cx, cz, owner)) } catch (e) { srErr("выглаживание", e) }

    function put(type, opts) {
        var pool = have[type]
        if (!pool || !pool.length) { skipped.push(type + ": нет шаблона"); return null }
        var name = srPick(pool)
        var o = {
            search: true, searchR: opts.searchR || 10, maxDrop: opts.maxDrop || undefined, rock: stone, wood: takeWood(),
            metal: takeMetal(), glass: takeGlass(), wealth: wealth, label: "поселение " + type,
        }
        if (type === "трущобы") {
            // сколочено из чего попало: вторая порода своя, достаток - нижний
            o.wood2 = takeWood()
            if (o.wood2 === o.wood) o.wood2 = srPick(global.TFG_STRUCTURES.woods.filter(w => w !== o.wood))
            o.wealth = 0
        }
        if (type === "дом" || type === "малый" || type === "большой" || type === "особняк" || type === "трущобы") {
            // половина дворов живёт главным ремеслом округи, остальные - кто чем
            o.trade = Math.random() < 0.5 ? mainCraft : SR_TRADES[tradeN++ % SR_TRADES.length]
        }
        if (opts.faceDir) o.faceDir = opts.faceDir
        if (opts.veto) o.veto = opts.veto
        var res = global.TFG_STRUCTURES.place(level, opts.x, opts.z, name, null, owner, o)
        if (typeof res === "string") {
            skipped.push(type + " (" + name + "): " + res)
            srLog(type + " не встал: " + res)
            return null
        }
        zones.push(res.zone)
        placed.push({
            name: name, type: type, trade: o.trade || null, x: res.x, y: res.y, z: res.z,
            steps: res.steps, size: res.size, door: res.door, wood: o.wood, wood2: o.wood2 || null, zone: res.zone,
            metal: o.metal, glass: o.glass,          // для пересборки той же отделкой (srRebuild)
        })
        return res
    }

    // ── форт в середине ──────────────────────────────────────────────────────
    var fort = put("форт", { x: Math.floor(cx), z: Math.floor(cz), searchR: 16 })
    // не встал у середины - ищем шире: местность уже выглажена, жаль бросать
    if (!fort) fort = put("форт", { x: Math.floor(cx), z: Math.floor(cz), searchR: 32 })
    if (!fort) fort = put("форт", { x: Math.floor(cx), z: Math.floor(cz), searchR: 48 })
    if (!fort) fort = put("форт", { x: Math.floor(cx), z: Math.floor(cz), searchR: 96, maxDrop: 5 })
    if (!fort) {
        // Совсем не встал: выглаженное и засыпанное откатываем. Раньше зоны рельефа оставались ничьими
        // (и в данных сервера, и в мире), а мир через минуту строил снова - сотня слепков за круг и лаги.
        zones.slice().reverse().forEach(z => { try { global.TFG_ZONES.restore(z, "форт не встал") } catch (e) { } })
        srLog("форт не встал и шире - откатываю выглаженное: зон " + zones.length)
        return "форт не встал: " + (skipped[skipped.length - 1] || "негде")
    }
    var fx = fort.x + fort.size[0] / 2, fz = fort.z + fort.size[2] / 2
    var fortHalf = Math.ceil(Math.max(fort.size[0], fort.size[2]) / 2)
    var ringR = fortHalf + SR_RING_GAP

    // ── кольцо ───────────────────────────────────────────────────────────────
    srLay(null, level, srRing(fx, fz, ringR), SR_ROAD_W - 1, pathMat, cmds, paved)

    // ── главная дорога от ворот форта наружу ─────────────────────────────────
    var roadAng = Math.random() * 6.283185307179586
    if (!isFinite(fx) || !isFinite(fz) || !isFinite(ringR)) {
        srErr("поселение", "форт дал негодные координаты: x=" + fx + " z=" + fz + " кольцо=" + ringR)
        return "форт встал криво - попробуйте другое место"
    }
    if (fort.door && fort.door.out) {
        var o1 = fort.door.out
        if (o1.dx || o1.dz) roadAng = Math.atan2(o1.dz, o1.dx)
    }
    // дорога начинается у самих ворот, а не на окружности - иначе к двери форта не подойти
    var gx0 = fx + Math.cos(roadAng) * (fortHalf + 1), gz0 = fz + Math.sin(roadAng) * (fortHalf + 1)
    if (fort.door) {
        var fo = fort.door.out || { dx: 0, dz: 1 }
        gx0 = fort.door.x + fo.dx
        gz0 = fort.door.z + fo.dz
        roadAng = Math.atan2(gz0 - fz, gx0 - fx)
    }
    if (!isFinite(roadAng)) roadAng = Math.random() * 6.283185307179586
    if (!isFinite(gx0) || !isFinite(gz0)) {
        gx0 = fx + Math.cos(roadAng) * (fortHalf + 1)
        gz0 = fz + Math.sin(roadAng) * (fortHalf + 1)
    }
    var road = srWalk(level, gx0, gz0, roadAng, Math.round((ringR + 40) / 2))
    srLay(null, level, road, SR_ROAD_W, pathMat, cmds, paved)

    // ── башня сразу за кольцом, у выезда ─────────────────────────────────────
    var towerAng = roadAng + (Math.random() < 0.5 ? -1 : 1) * 0.45
    var tInfo = null
    try { tInfo = global.TFG_STRUCTURES.info(have["башня"][0]) } catch (e) { }
    var tHalf = tInfo && tInfo.size ? Math.ceil(Math.max(tInfo.size[0], tInfo.size[2]) / 2) : 8
    var tower = put("башня", {
        x: Math.round(fx + Math.cos(towerAng) * (ringR + tHalf + 4)),
        z: Math.round(fz + Math.sin(towerAng) * (ringR + tHalf + 4)), searchR: 10,
    })
    if (tower) {
        // от порога башни к кольцу
        var tdo = tower.door ? (tower.door.out || { dx: 0, dz: 1 }) : { dx: 0, dz: 1 }
        var tsx = tower.door ? tower.door.x + tdo.dx : tower.x + tower.size[0] / 2
        var tsz = tower.door ? tower.door.z + tdo.dz : tower.z + tower.size[2] / 2
        // сперва пара шагов прямо от крыльца, только потом поворот к кольцу:
        // иначе тропа сразу уходит вбок и срезается с пятна самой башни
        var tOut = [{ x: tsx, z: tsz }, { x: tsx + tdo.dx * 2, z: tsz + tdo.dz * 2 },
            { x: tsx + tdo.dx * 4, z: tsz + tdo.dz * 4 }]
        var tFrom = tOut[tOut.length - 1]
        var tAng = Math.atan2(fz - tFrom.z, fx - tFrom.x)
        srLay(null, level, tOut.concat(srWalk(level, tFrom.x, tFrom.z, tAng, 16)),
            SR_PATH_W, pathMat, cmds, paved)
    }

    // ── лучи и дома вдоль них ────────────────────────────────────────────────
    var rest = plan.filter(p => p.type !== "форт" && p.type !== "башня" && p.type !== "трущобы")
    var spokes = Math.max(2, Math.min(5, Math.ceil(rest.length / 3)))     // меньше лучей, гуще дома
    var lots = []
    for (var si = 0; si < spokes; si++) lots.push([])
    rest.forEach((item, i) => { lots[i % spokes].push(item) })
    // Квартал трущоб: свои лучи, хибары стена к стене по обе стороны тропы
    var slumItems = plan.filter(p => p.type === "трущобы")
    for (var sl = 0; sl < slumItems.length; sl += SR_SLUM_PER_SPOKE) {
        var slumLot = slumItems.slice(sl, sl + SR_SLUM_PER_SPOKE)
        slumLot.slum = true
        lots.push(slumLot)
    }
    spokes = lots.length

    var ends = [], spokePaths = []
    lots.forEach((lot, si2) => {
        if (!lot.length) return
        // углы разводим по кругу и уводим от главной дороги
        var base = roadAng + 3.141592653589793 * 0.35 + si2 * (6.283185307179586 - 3.141592653589793 * 0.7) / spokes
        var ang = base + (Math.random() - 0.5) * 0.25
        if (!isFinite(ang)) ang = si2 * 6.283185307179586 / spokes
        var sx1 = fx + Math.cos(ang) * (ringR + 1), sz1 = fz + Math.sin(ang) * (ringR + 1)
        var pts = srWalk(level, sx1, sz1, ang, Math.round(SR_SPOKE_MAX / 2))
        // Домам нужно место вдоль луча. Если прогулка уткнулась рано (вода, обрыв),
        // достраиваем луч по прямой: пусть кусок ляжет условно, чем двор останется без улицы.
        var needPts = lot.slum ? 6 + Math.ceil(lot.length / 2) * 6 : 4 + lot.length * 8
        if (pts.length < needPts) {
            var tail = pts[pts.length - 1]
            for (var ex = pts.length; ex < needPts; ex++) {
                tail = { x: tail.x + Math.cos(ang) * 2, z: tail.z + Math.sin(ang) * 2 }
                pts.push(tail)
            }
        }
        srLay(null, level, pts, SR_ROAD_W, pathMat, cmds, paved)
        spokePaths.push(pts)
        var last = pts[pts.length - 1]
        if (!isFinite(last.x) || !isFinite(last.z)) {
            srErr("луч", "конец луча негоден: " + last.x + " " + last.z)
            last = { x: fx + Math.cos(ang) * ringR, z: fz + Math.sin(ang) * ringR }
        }
        ends.push({ ang: ang, x: last.x, z: last.z, r: Math.sqrt((last.x - fx) * (last.x - fx) + (last.z - fz) * (last.z - fz)) })

        // Дома по обе стороны луча, тесно, как в трущобах: коробки шаблонов могут налезать
        // друг на друга, не налезают только сами стены (structures.js сверяет столбы с блоками).
        // Каждая сторона ведёт свой счёт, поэтому дома встают парами - напротив друг друга.
        var walkBy = { "1": 2, "-1": 2 }, prevBy = { "1": 0, "-1": 0 }, side = 1
        lot.forEach(item => {
            var info = null
            try { info = global.TFG_STRUCTURES.info(srPick(have[item.type] || [])) } catch (e) { }
            var half = info && info.size ? Math.ceil(Math.max(info.size[0], info.size[2]) / 2) : 10
            var thin = info && info.size ? Math.ceil(Math.min(info.size[0], info.size[2]) / 2) : 6
            // хибары - вплотную: шаг ровно в ширину, без зазора
            var step = lot.slum ? half : Math.ceil(half * SR_DENSE)
            walkBy[side] += prevBy[side] + step + (lot.slum ? 0 : 1)
            prevBy[side] = step
            var t = Math.min(pts.length - 1, Math.round(walkBy[side] / 2))
            var p = pts[t]
            var nx = -Math.sin(ang) * side, nz = Math.cos(ang) * side
            var gap = lot.slum ? 1 : 2
            var bx = Math.round(p.x + nx * (thin + gap)), bz = Math.round(p.z + nz * (thin + gap))
            // дверь смотрит на тропу
            var faceDir = Math.abs(nx) > Math.abs(nz) ? (nx > 0 ? "west" : "east") : (nz > 0 ? "north" : "south")
            var res = put(item.type, {
                x: bx, z: bz, faceDir: faceDir, searchR: lot.slum ? 5 : 12,
                // На полотно не встаём: ни одна стена не должна оказаться на тропе луча или на
                // кольце. Сверяем столбы с блоками постройки (hits), а не её коробку.
                veto: (vx, vz, vhalf, hits) => {
                    var reach = vhalf + 2
                    for (var ri = 0; ri < pts.length; ri++) {
                        var ddx = pts[ri].x - vx, ddz = pts[ri].z - vz
                        if (ddx * ddx + ddz * ddz > reach * reach) continue
                        for (var wx = -1; wx <= 1; wx++)
                            for (var wz = -1; wz <= 1; wz++) if (hits(pts[ri].x + wx, pts[ri].z + wz)) return true
                    }
                    var rn = Math.ceil(6.283185307179586 * ringR)
                    for (var ra = 0; ra < rn; ra++) {
                        var a2 = ra / rn * 6.283185307179586
                        for (var rw = -1; rw <= 1; rw++) {
                            var rx = fx + Math.cos(a2) * (ringR + rw), rz = fz + Math.sin(a2) * (ringR + rw)
                            if (Math.abs(rx - vx) > reach || Math.abs(rz - vz) > reach) continue
                            if (hits(rx, rz)) return true             // и на кольцо тоже
                        }
                    }
                    return false
                },
            })
            // не встал у самой тропы - пробуем отодвинуть подальше и без требования к развороту
            if (!res) {
                res = put(item.type, {
                    x: Math.round(p.x + nx * (half + 12)), z: Math.round(p.z + nz * (half + 12)), searchR: 20,
                })
            }
            side = -side
            if (!res || !res.door) return
            // Дорожка от порога прямо к лучу: дом уже развёрнут дверью к тропе, поэтому
            // идём от крыльца по направлению выхода и доворачиваем к ближайшей клетке полотна.
            var out = res.door.out || { dx: 0, dz: 1 }
            // Тропа начинается не вплотную к двери, а у подножия крыльца: за пятном постройки.
            // Иначе пара клеток остаётся зажатой между ступенями и отрезанной от сети.
            var sx0 = res.door.x + out.dx, sz0 = res.door.z + out.dz
            var rcore = null
            try { rcore = global.TFG_STRUCTURES.core(res.zone) } catch (e) { }
            for (var esc = 0; esc < 12; esc++) {
                // за стену самой постройки (по её блокам), а не за край коробки
                if (rcore) { if (!rcore.cols[sx0 + "," + sz0]) break }
                else {
                    var inX = sx0 >= res.x - 1 && sx0 <= res.x + res.size[0]
                    var inZ = sz0 >= res.z - 1 && sz0 <= res.z + res.size[2]
                    if (!inX || !inZ) break
                }
                sx0 += out.dx
                sz0 += out.dz
            }
            var near = pts[0], nd = 1e9
            pts.forEach(q => {
                var d2 = (q.x - sx0) * (q.x - sx0) + (q.z - sz0) * (q.z - sz0)
                if (d2 < nd) { nd = d2; near = q }
            })
            var head = [{ x: sx0, z: sz0 }, { x: sx0 + out.dx * 2, z: sz0 + out.dz * 2 }]
            var from = head[head.length - 1]
            var bAng = Math.atan2(near.z - from.z, near.x - from.x)
            var walkPts = srWalk(level, from.x, from.z, bAng, Math.ceil(Math.sqrt(nd) / 2) + 2)
            srLay(null, level, head.concat(walkPts, [{ x: near.x, z: near.z }]), SR_PATH_W + 1, pathMat, cmds, paved)
            // перед самой дверью - широкая площадка: вход должно быть видно издалека
            for (var lx = -2; lx <= 2; lx++) {
                for (var lz = -2; lz <= 2; lz++) {
                    if (Math.abs(lx) + Math.abs(lz) > 3) continue
                    srPave(null, level, Math.round(sx0) + lx, Math.round(sz0) + lz, pathMat, cmds, paved)
                }
            }
        })
    })

    // ── хорды между разошедшимися лучами ─────────────────────────────────────
    ends.sort((a, b) => a.ang - b.ang)
    if (ends.length > 1) {
        for (var ei = 0; ei < ends.length; ei++) {
            var e1 = ends[ei], e2 = ends[(ei + 1) % ends.length]
            var dist = Math.sqrt((e1.x - e2.x) * (e1.x - e2.x) + (e1.z - e2.z) * (e1.z - e2.z))
            if (dist <= SR_CHORD_AT) continue
            srLay(null, level, srArc(fx, fz, Math.min(e1.r, e2.r) * 0.8, e1.ang, e2.ang),
                SR_PATH_W, pathMat, cmds, paved)
            srLog("лучи разошлись на " + Math.round(dist) + " блоков - связал дугой")
        }
    }

    // ── тропа не заходит на пятна построек ───────────────────────────────────
    // Коробки теперь налезают друг на друга и на тропы, поэтому снимаем тропу только
    // со столбов, где стоят блоки постройки (core), а не со всей коробки.
    var coreOf = b => { try { return global.TFG_STRUCTURES.core(b.zone) } catch (e) { return null } }
    var foot = placed.map(b => ({
        x1: b.x - 1, x2: b.x + b.size[0], z1: b.z - 1, z2: b.z + b.size[2],
        core: b.type === "форт" || b.type === "башня" ? null : coreOf(b),     // у них двор внутри стен
        dx: b.door ? b.door.x : null, dz: b.door ? b.door.z : null,
        ox: b.door && b.door.out ? b.door.out.dx : 0, oz: b.door && b.door.out ? b.door.out.dz : 0,
    }))
    var cut = 0
    cmds = cmds.filter(item => {
        if (typeof item === "string") return true
        for (var fi = 0; fi < foot.length; fi++) {
            var f = foot[fi]
            if (item.x < f.x1 || item.x > f.x2 || item.z < f.z1 || item.z > f.z2) continue
            if (f.core && !f.core.cols[item.x + "," + item.z]) continue
            if (f.dx !== null) {
                var alongX = f.ox !== 0
                var along = alongX ? (item.x - f.dx) * f.ox : (item.z - f.dz) * f.oz
                var sideD = alongX ? Math.abs(item.z - f.dz) : Math.abs(item.x - f.dx)
                if (along >= 0 && sideD <= 1) continue
            }
            cut++
            delete paved[item.x + "," + item.z]
            return false
        }
        return true
    })
    if (cut) srLog("клеток тропы снято с пятен построек: " + cut)

    // ── непрерывность: ни один кусок тропы не должен остаться в стороне ──────
    var cellsList = []
    for (var ck0 in paved) cellsList.push(ck0)
    if (cellsList.length > 1) {
        var seen = {}, comps = []
        cellsList.forEach(startK => {
            if (seen[startK]) return
            var stack = [startK], group = []
            seen[startK] = 1
            while (stack.length) {
                var cur = stack.pop()
                group.push(cur)
                var q = cur.split(",")
                var qx = Number(q[0]), qz = Number(q[1])
                ;[[1, 0], [-1, 0], [0, 1], [0, -1]].forEach(d => {
                    var nk = (qx + d[0]) + "," + (qz + d[1])
                    if (paved[nk] && !seen[nk]) { seen[nk] = 1; stack.push(nk) }
                })
            }
            comps.push(group)
        })
        if (comps.length > 1) {
            comps.sort((a, b) => b.length - a.length)
            var mainComp = comps[0]
            // Клочки у самого крыльца отбрасываем: под навесом мостить нельзя, и такая
            // клетка всё равно останется отрезанной. Пусть тропа честно кончается у крыльца.
            var drop = {}
            for (var di = 1; di < comps.length; di++) {
                if (comps[di].length > 6) continue
                var nearFoot = comps[di].some(k => {
                    var q = k.split(","), qx = Number(q[0]), qz = Number(q[1])
                    return foot.some(f => qx >= f.x1 - 2 && qx <= f.x2 + 2 && qz >= f.z1 - 2 && qz <= f.z2 + 2)
                })
                if (!nearFoot) continue
                comps[di].forEach(k => { drop[k] = 1; delete paved[k] })
                comps[di] = []
            }
            if (Object.keys(drop).length) {
                cmds = cmds.filter(item => typeof item === "string" || !drop[item.x + "," + item.z])
            }
            comps = comps.filter(c => c.length)
            for (var ci = 1; ci < comps.length; ci++) {
                // ближайшая пара клеток между куском и главной сетью
                var bestA = null, bestB = null, bestD = 1e18
                comps[ci].forEach(ak => {
                    var qa = ak.split(","), ax2 = Number(qa[0]), az2 = Number(qa[1])
                    mainComp.forEach(bk => {
                        var qb = bk.split(","), bx2 = Number(qb[0]), bz2 = Number(qb[1])
                        var dd = (ax2 - bx2) * (ax2 - bx2) + (az2 - bz2) * (az2 - bz2)
                        if (dd < bestD) { bestD = dd; bestA = { x: ax2, z: az2 }; bestB = { x: bx2, z: bz2 } }
                    })
                })
                if (!bestA) continue
                srLay(null, level, [bestA, bestB], SR_PATH_W, pathMat, cmds, paved)
                mainComp = mainComp.concat(comps[ci])
            }
            srLog("сшито кусков тропы: " + (comps.length - 1))
        }
    }

    // Клетки троп запоминаем ДО украшений: заборы и грядки в маршруты попадать не должны,
    // иначе граф жителей рассыпается на полсотни кусков.
    var pathCells = []
    for (var pck in paved) {
        var pcp = pck.split(",")
        pathCells.push([Number(pcp[0]), Number(pcp[1])])
    }

    // ── обжитость: заборы, фонари, грядки, поле, промквартал ────────────────
    var decorCells = {}
    try {
        var busy = {}
        for (var bk in paved) busy[bk] = 1
        // занято только там, где стены и клетка вокруг них: огороды и заборы жмутся к домам
        placed.forEach(b => {
            var core = coreOf(b)
            // у форта и башни внутри стен двор - туда огороды и заборы не ставим
            if (core && b.type !== "форт" && b.type !== "башня") { for (var nk in core.near) busy[nk] = 1; return }
            for (var bx2 = b.x - 1; bx2 <= b.x + b.size[0]; bx2++) {
                for (var bz2 = b.z - 1; bz2 <= b.z + b.size[2]; bz2++) busy[bx2 + "," + bz2] = 1
            }
        })
        global.TFG_DECOR.build({
            level: level, dim: String(level.getDimension()), fx: fx, fz: fz, ringR: ringR,
            wood: woodSet[0], rock: stone, placed: placed, paths: spokePaths.concat([road]), cmds: cmds,
            busy: busy, cells: decorCells, indAng: roadAng + 2.4,
        })
    } catch (e) { srErr("обжитость", e) }

    // ── земля: пустырь у крепости, деревья округи, грязь у троп и домов ──────
    var landing = null, treeSpots = []
    try {
        var dressed = srDress(level, {
            fx: fx, fz: fz, ringR: ringR, placed: placed, paved: paved, pathCells: pathCells, cmds: cmds,
            angles: [roadAng, towerAng].concat(ends.map(en => en.ang)), trees: regionTrees,
        })
        landing = dressed.landing
        treeSpots = dressed.trees
        dressed.mud.forEach(c => { paved[c[0] + "," + c[1]] = paved[c[0] + "," + c[1]] || 1 })   // и грязь - под зону отката
    } catch (e) { srErr("земля поселения", e) }
    // деревья высокие: под каждое - своя зона в рост дерева
    var treeTiles = {}
    treeSpots.forEach(t => { treeTiles[Math.floor(t[0] / 16) + "," + Math.floor(t[1] / 16)] = 1 })
    for (var ttk in treeTiles) {
        var ttp = ttk.split(","), ttx = Number(ttp[0]) * 16 - 4, ttz = Number(ttp[1]) * 16 - 4
        var tty0 = srTop(level, ttx + 12, ttz + 12)
        var tzid = global.TFG_ZONES.snapshot(level, ttx, tty0 - 6, ttz, ttx + 23, tty0 + 34, ttz + 23,
            { label: "поселение деревья", owner: owner || null })
        if (String(tzid).indexOf("z") === 0) zones.push(tzid)
    }

    // ── зоны под тропы: плитками 16x16, чтобы откат был полным ───────────────
    var boxes = zones.map(zid => {
        var zz = global.TFG_ZONES.get(zid)
        return zz ? zz.box : null
    }).filter(b => b)
    var cover = {}
    for (var dk in decorCells) paved[dk] = paved[dk] || 1
    // сглаживание трогает соседние клетки, поэтому зоной накрываем и их
    var around = {}
    for (var ak in paved) {
        var ap = ak.split(","), ax3 = Number(ap[0]), az3 = Number(ap[1])
        for (var adx = -1; adx <= 1; adx++) {
            for (var adz = -1; adz <= 1; adz++) around[(ax3 + adx) + "," + (az3 + adz)] = 1
        }
    }
    for (var ak2 in around) paved[ak2] = paved[ak2] || 1
    for (var pk in paved) {
        var pc = pk.split(","), px2 = Number(pc[0]), pz2 = Number(pc[1])
        var inside = false
        for (var bi = 0; bi < boxes.length; bi++) {
            var bb = boxes[bi]
            if (px2 >= bb.x1 && px2 <= bb.x2 && pz2 >= bb.z1 && pz2 <= bb.z2) { inside = true; break }
        }
        if (!inside) cover[Math.floor(px2 / 16) + "," + Math.floor(pz2 / 16)] = 1
    }
    for (var ck in cover) {
        var cc = ck.split(","), gx1 = Number(cc[0]) * 16 - 1, gz1 = Number(cc[1]) * 16 - 1
        var gx2 = gx1 + 17, gz2 = gz1 + 17
        var gl = 1e9, gh = -1e9
        for (var tx2 = gx1; tx2 <= gx2; tx2 += 2) {
            for (var tz2 = gz1; tz2 <= gz2; tz2 += 2) {
                var tty = srTop(level, tx2, tz2)
                if (tty < gl) gl = tty
                if (tty > gh) gh = tty
            }
        }
        // с запасом: под тропой ещё подсыпка, а над ней заборы и фонари
        var gid = global.TFG_ZONES.snapshot(level, gx1, gl - 8, gz1, gx2, gh + 9, gz2,
            { label: "поселение тропа", owner: owner || null })
        if (String(gid).indexOf("z") === 0) zones.push(gid)
    }

    // тропы кладём последними: поверх выровненных площадок; в самом конце - полировка троп
    cmds.push({ polish: true, dim: String(level.getDimension()), cells: pathCells.slice() })
    srQueue(cmds)

    var data = srLoad()
    var id = "s" + Number(level.getTime()) + "_" + Math.floor(Math.random() * 1000)
    while (data[id]) id = "s" + Number(level.getTime()) + "_" + Math.floor(Math.random() * 100000)
    data[id] = {
        id: id, dim: String(level.getDimension()), stone: stone, x: Math.floor(cx), z: Math.floor(cz),
        site: opts.site || null, faction: opts.faction || null, name: opts.name || null,
        ring: Math.round(ringR), zones: zones, buildings: placed, skipped: skipped, paths: pathCells,
        woods: woodSet, metals: metalSet, glass: glassSet, wealth: wealth, craft: mainCraft,
        landing: landing,                 // пустырь у крепости: сюда садятся дирижабли каравана
        made: Number(level.getTime()),
    }
    srSave(data)
    srLog("поселение " + id + ": камень " + stone + ", дерево " + woodSet.join("/") +
        ", металл " + metalSet.join("/") + ", достаток " + wealth + ", ремесло " + mainCraft +
        ", построек " + placed.length + ", зон " + zones.length +
        (skipped.length ? ", не встало " + skipped.length : ""))
    return data[id]
}

/** Русское имя камня -> идентификатор породы TFC. */
const SR_ROCKS = {
    "андезит": "andesite", "гнейс": "gneiss", "гранит": "granite", "известняк": "limestone",
    "доломит": "dolomite", "мрамор": "marble", "дацит": "dacite", "мел": "chalk", "базальт": "basalt",
    "филлит": "phyllite", "сланец": "shale", "габбро": "gabbro", "кварцит": "quartzite",
    "риолит": "rhyolite", "конгломерат": "conglomerate",
}
function srRockId(ru) { return SR_ROCKS[ru] || "granite" }

// ─── Очередь укладки ─────────────────────────────────────────────────────────

var SR_QUEUE = []
const SR_PER_TICK = 120

function srQueue(cmds) { if (cmds.length) SR_QUEUE.push({ cmds: cmds, i: 0 }) }

/**
 * Пересветка. Фонарь TFC гаснет навсегда, если в момент случайного тика в баке пусто,
 * поэтому в старых поселениях свет мёртвый. Эта работа проходит по постройкам и тропам,
 * находит каждый фонарь и заправляет его заново - по столбу за раз, чтобы не подвесить
 * сервер. Ставится в ту же очередь, что и мощение.
 */
function srLampColumn(col) {
    var level = SR_SERVER.overworld()
    try { level = SR_SERVER.getLevel(col.dim) || level } catch (e) { }
    var found = 0
    for (var y = col.y1; y <= col.y2; y++) {
        var id = ""
        try { id = String(level.getBlock(col.x, y, col.z).id) } catch (e) { continue }
        if (id.indexOf("tfc:metal/lamp/") !== 0) continue
        try { if (global.TFG_STRUCTURES.lightLamp(level, col.x, y, col.z)) found++ } catch (e) { }
    }
    SR_LIT += found
    return found
}

var SR_LIT = 0

/** Загружены ли чанки, которых касается шаг укладки (factions/structures.js заказывает прогрузку). */
function srItemReady(item) {
    try {
        if (!global.TFG_CHUNK_READY_AT) return true
        if (typeof item === "string") return global.TFG_CHUNK_READY(item)
        var dim = item.dim || "minecraft:overworld"
        if (item.polish) {
            var ok = true, seen = {}
            item.cells.forEach(c => {
                var k = (Number(c[0]) >> 4) + "," + (Number(c[1]) >> 4)
                if (seen[k]) return
                seen[k] = 1
                if (!global.TFG_CHUNK_READY_AT(dim, Number(c[0]), Number(c[1]))) ok = false
            })
            return ok
        }
        if (item.x !== undefined && item.z !== undefined) return global.TFG_CHUNK_READY_AT(dim, item.x, item.z)
    } catch (e) { }
    return true
}

/** Собрать столбы, которые надо проверить: все постройки и полотно троп. */
function srLightJob(level, rec) {
    var cols = []
    var seen = {}
    var dim = rec.dim || String(level.getDimension())
    var push = (x, z, y1, y2) => {
        var k = x + "," + z
        if (seen[k]) return
        seen[k] = 1
        cols.push({ scanCol: true, x: x, z: z, y1: y1, y2: y2, dim: dim })
    }
    ;(rec.buildings || []).forEach(b => {
        for (var x = b.x - 1; x <= b.x + b.size[0]; x++) {
            for (var z = b.z - 1; z <= b.z + b.size[2]; z++) push(x, z, b.y - 1, b.y + b.size[1] + 2)
        }
    })
    ;(rec.paths || []).forEach(c => {
        var x = Number(c[0]), z = Number(c[1])
        var top = 70
        try { top = global.TFG_STRUCTURES.top(level, x, z) } catch (e) { }
        for (var dx = -3; dx <= 3; dx++) {
            for (var dz = -3; dz <= 3; dz++) push(x + dx, z + dz, top, top + 4)
        }
    })
    return cols
}

ServerEvents.tick(event => {
    if (!SR_SERVER) SR_SERVER = event.server
    if (!SR_QUEUE.length) return
    // дорога и отвилки ложатся поверх площадок, поэтому сначала должны встать все постройки
    try { if (global.TFG_STRUCTURES.busy()) return } catch (e) { }
    var job = SR_QUEUE[0]
    var n = 0
    while (job.i < job.cmds.length && n < SR_PER_TICK) {
        var item = job.cmds[job.i]
        // чанк клетки не загружен - мощение и подсыпка в нём молча пропали бы: ждём прогрузки
        if (!srItemReady(item)) {
            job.wait = (job.wait || 0) + 1
            if (job.wait < 300) return
        }
        job.wait = 0
        try {
            if (typeof item === "string") SR_SERVER.runCommandSilent(item)
            else if (item.scanCol) srLampColumn(item)
            else if (item.polish) srPolishPaths(item)
            else if (item.lamp) {
                // фонарь на столбе: заливаем лавой в момент постановки, иначе он погаснет
                var lvl2 = SR_SERVER.overworld()
                try { lvl2 = SR_SERVER.getLevel(item.dim || "minecraft:overworld") || lvl2 } catch (e2) { }
                global.TFG_STRUCTURES.lightLamp(lvl2, item.x, item.y, item.z)
            }
            else srPaveNow(item)
        } catch (e) { srErr("укладка", e) }
        job.i++
        n++
    }
    if (job.i >= job.cmds.length) SR_QUEUE.shift()
})

/**
 * Снести улицу начисто: постройки и тропы вернуть в дикую природу через зоны,
 * жителей убрать вместе с записями. После этого от поселения не остаётся ничего.
 */
function srRemove(id) {
    var data = srLoad()
    var rec = data[id]
    if (!rec) return null
    var villages = 0
    try { villages = global.TFG_SETTLERS.purge(id) } catch (e) { srErr("уборка жителей", e) }
    var failed = 0
    // В обратном порядке: зоны выглаживания сняты первыми - с дикой земли - и откатываться
    // должны последними, иначе слепки построек вернули бы уже выглаженный рельеф.
    ;(rec.zones || []).slice().reverse().forEach(z => { if (global.TFG_ZONES.restore(z, "улицу убрали")) failed++ })   // restore: null - ушла в откат
    // Тропы кладутся командами мимо зон - откат их не возвращал, и на месте снесённого поселения оставались
    // дорожки. Возвращаем траву той же почвы по клеткам троп (после отката зон - очередь общая, по порядку).
    try {
        var dim = rec.dim || "minecraft:overworld", pc = []
        ;(rec.paths || []).forEach(c => {
            var x = Number(c[0]), z = Number(c[1])
            SR_PATH_SOILS.forEach(soil => pc.push("execute in " + dim + " run fill " + (x - 3) + " 40 " + (z - 3) + " " + (x + 3) + " 220 " + (z + 3) +
                " tfc:grass/" + soil + " replace tfc:grass_path/" + soil))
        })
        SR_REPAIR = SR_REPAIR.concat(pc)
    } catch (e) { srErr("откат троп", e) }
    delete data[id]
    srSave(data)
    srLog("улица " + id + " снесена: зон " + (rec.zones || []).length + ", поселений " + villages)
    return { zones: (rec.zones || []).length, failed: failed, villages: villages }
}

/**
 * Снять улицу с учёта без отката её зон: жители уходят, тропы - в траву, запись удаляется, а зоны
 * остаются - их забывает или откатывает тот, кто зовёт (world.js, /tfgworld reset).
 */
function srForget(id) {
    var data = srLoad()
    var rec = data[id]
    if (!rec) return null
    var villages = 0
    try { villages = global.TFG_SETTLERS.purge(id) } catch (e) { srErr("уборка жителей", e) }
    try {
        var dim = rec.dim || "minecraft:overworld", pc = []
        ;(rec.paths || []).forEach(c => {
            var x = Number(c[0]), z = Number(c[1])
            SR_PATH_SOILS.forEach(soil => pc.push("execute in " + dim + " run fill " + (x - 3) + " 40 " + (z - 3) + " " + (x + 3) + " 220 " + (z + 3) +
                " tfc:grass/" + soil + " replace tfc:grass_path/" + soil))
        })
        SR_REPAIR = SR_REPAIR.concat(pc)
    } catch (e) { srErr("откат троп", e) }
    var zones = (rec.zones || []).slice()
    delete data[id]
    srSave(data)
    srLog("улица " + id + " снята с учёта: зон " + zones.length + ", поселений " + villages)
    return { zones: zones, villages: villages }
}

/** Ближайшая к точке улица - по ней работают и снос, и заселение. */
function srNearestStreet(x, z) {
    var data = srLoad()
    var best = null, bestD = 1e18
    for (var id in data) {
        var st = data[id]
        var d = Math.pow(st.x - x, 2) + Math.pow(st.z - z, 2)
        if (d < bestD) { bestD = d; best = st }
    }
    return best
}

/**
 * Пересобрать постройки улицы на их же местах: тот же шаблон, поворот, пол и отделка.
 * Разбитое встаёт целым, хранилища наполняются заново. Зоны отката прежние - снос
 * улицы по-прежнему возвращает дикую природу. Тропы и фонари не трогаем.
 * Возвращает число поставленных построек или текст ошибки.
 */
function srRebuild(level, id) {
    var rec = srLoad()[id]
    if (!rec) return "нет улицы " + id
    var n = 0
    ;(rec.buildings || []).forEach((b, i) => {
        var o = {
            search: false, baseY: b.y, reuseZone: b.zone, rock: rec.stone, wood: b.wood, wood2: b.wood2 || undefined,
            metal: b.metal || (rec.metals || [])[i % Math.max(1, (rec.metals || []).length)],
            glass: b.glass || (rec.glass || [])[i % Math.max(1, (rec.glass || []).length)],
            wealth: b.type === "трущобы" ? 0 : rec.wealth, label: "поселение " + b.type,
        }
        if (b.trade) o.trade = b.trade
        var cx = b.x + Math.floor(b.size[0] / 2), cz = b.z + Math.floor(b.size[2] / 2)
        var res = global.TFG_STRUCTURES.place(level, cx, cz, b.name, b.steps, rec.owner || "мир", o)
        if (typeof res === "string") srLog("пересборка " + b.name + ": " + res)
        else n++
    })
    // и тропы старого поселения - отполировать (после того, как встанут постройки)
    if (rec.paths && rec.paths.length) srQueue([{ polish: true, dim: rec.dim || String(level.getDimension()), cells: rec.paths }])
    srLog("улица " + id + ": пересобрано построек " + n + " из " + (rec.buildings || []).length)
    return n
}

global.TFG_STREET = {
    build: (level, x, z, houses, owner) => srBuild(level, x, z, houses, owner),
    rebuild: (level, id) => srRebuild(level, id),
    fillWater: (level, id) => srFillWaterStreet(level, id),
    paths: id => { var r = srLoad()[id]; return r && r.paths ? r.paths : [] },
    list: () => srLoad(),
    remove: id => srRemove(id),
    forget: id => srForget(id),
    nearest: (x, z) => srNearestStreet(x, z),
    // стройка идёт очередью по тикам: пока она не пуста, заселять рано
    busy: () => SR_QUEUE.length > 0,
    light: (level, rec) => srQueue(srLightJob(level, rec)),
}

// ─── Команды ─────────────────────────────────────────────────────────────────

ServerEvents.commandRegistry(event => {
    var Commands = event.commands
    var Arguments = event.arguments
    try {
        event.register(Commands.literal("tfgstreet").requires(s => s.hasPermission(2))
            .then(Commands.literal("place").executes(ctx => srCmdPlace(ctx, 0))
                .then(Commands.argument("домов", Arguments.INTEGER.create(event))
                    .executes(ctx => srCmdPlace(ctx, Number(Arguments.INTEGER.getResult(ctx, "домов"))))))
            .then(Commands.literal("list").executes(ctx => {
                if (!SR_SERVER) SR_SERVER = ctx.source.getServer()
                var data = srLoad()
                var rows = []
                for (var id in data) {
                    var s = data[id]
                    rows.push("§f" + id + " §7камень " + s.stone + ", построек " + s.buildings.length +
                        ", на " + s.x + " " + s.z)
                }
                ctx.source.sendSuccess(Text.of(rows.length ? rows.join("\n") : "§7улиц нет"), false)
                return 1
            }))
            .then(Commands.literal("light").executes(ctx => {
                if (!SR_SERVER) SR_SERVER = ctx.source.getServer()
                var p = ctx.source.getPlayerOrException()
                var data = srLoad()
                var best = null, bestD = 1e18
                for (var id in data) {
                    var st = data[id]
                    var d = Math.pow(st.x - p.getX(), 2) + Math.pow(st.z - p.getZ(), 2)
                    if (d < bestD) { bestD = d; best = st }
                }
                if (!best) { ctx.source.sendFailure(Text.of("Поселений поблизости нет.")); return 1 }
                SR_LIT = 0
                var cols = srLightJob(p.level, best)
                srQueue(cols)
                ctx.source.sendSuccess(Text.of("Пересвечиваю " + best.id + ": столбов " + cols.length +
                    ". Итог будет в логе."), false)
                return 1
            }))
            .then(Commands.literal("remove").executes(ctx => {
                if (!SR_SERVER) SR_SERVER = ctx.source.getServer()
                var p = ctx.source.getPlayerOrException()
                var data = srLoad()
                var best = null, bestD = 1e18
                for (var id in data) {
                    var s = data[id]
                    var d = Math.pow(s.x - p.getX(), 2) + Math.pow(s.z - p.getZ(), 2)
                    if (d < bestD) { bestD = d; best = s }
                }
                if (!best) { ctx.source.sendFailure(Text.of("Улиц поблизости нет.")); return 1 }
                var res = srRemove(best.id)
                ctx.source.sendSuccess(Text.of("Убираю улицу: зон " + res.zones + ", поселений жителей " +
                    res.villages + ". Рельеф вернётся как был."), false)
                return 1
            })))
    } catch (err) {
        console.error("[street] ошибка регистрации команд: " + err)
    }
})

function srCmdPlace(ctx, houses) {
    if (!SR_SERVER) SR_SERVER = ctx.source.getServer()
    var p = ctx.source.getPlayerOrException()
    var res = srBuild(p.level, Math.floor(p.getX()) + 30, Math.floor(p.getZ()) + 30, houses, String(p.uuid))
    if (typeof res === "string") ctx.source.sendFailure(Text.of("§c" + res))
    else {
        var by = {}
        res.buildings.forEach(b => { by[b.type] = (by[b.type] || 0) + 1 })
        var kinds = []
        for (var k in by) kinds.push(k + " " + by[k])
        ctx.source.sendSuccess(Text.of("Поселение " + res.id + ": камень " + res.stone +
            ", кольцо радиусом " + res.ring + ", достаток " + res.wealth + ", ремесло округи " + res.craft +
            "; построек " + res.buildings.length + ": " + kinds.join(", ")), false)
        // о неудачах молчать нельзя: иначе деревня молча выходит короче плана
        if (res.skipped && res.skipped.length) {
            ctx.source.sendSuccess(Text.of("§eНе встало " + res.skipped.length + ": " + res.skipped.join("; ")), false)
        }
    }
    return 1
}
