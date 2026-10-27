"use strict";
/**
 * ЖИТЕЛИ ПОСЕЛЕНИЯ: роли, распорядок дня, оборона, захват и восстановление.
 *
 * Отличие от гостей (factions/guests.js): гости приходят и уходят, а эти живут здесь.
 * У каждого своя койка, своё занятие днём и ночью, своя реакция на беду.
 *
 * РОЛИ
 *   правитель (он же глашатай) - при беде трубит в рог, пока все не укроются в форте;
 *   крестьянин - не покидает поселение: урожай, свечи, костры, рыбалка, разговоры;
 *   охотник    - уходит в лес за зверем, вооружён луком, арбалетом или простым стволом;
 *   лесоруб    - валит лес в округе, тут же сажает саженец и подбирает брёвна;
 *   рыцарь     - тяжёлая стража форта, спит посменно;
 *   стрелок    - стража со стволом, при осаде поднимается на стены;
 *   дружинник  - ополчение вне форта: днём живёт как крестьянин, но дерётся;
 *   бард       - ходит по поселению и играет, жители отзываются;
 *   торговец   - большую часть времени бездельничает, с игроком торгует без меню.
 *
 * ХРАНЕНИЕ. Всё лежит в данных сервера через factions/store.js (кусками по 20 000 символов:
 * длинная строка в NBT молча обнуляется). Ни одна запись не хранит ссылок на живые объекты -
 * только координаты, идентификаторы и uuid. Поэтому поселение всегда можно поднять заново
 * или снести до дикой природы: /tfgvillage despawn убирает жителей, /tfgstreet remove - постройки.
 *
 * Команды: /tfgvillage list | info | make | spawn | despawn | schedule | alarm | raid | surrender |
 *          upkeep | remove | say
 */

var SE_SERVER = null
var SE_DATA = null

const SE_TICK = 20                   // раз в секунду
const SE_DAY = 24000                 // длина суток
const SE_NIGHT_FROM = 12800          // после этого времени суток - ночь
const SE_NIGHT_TO = 23000
const SE_ALARM_RADIUS = 96           // на таком расстоянии от середины поселения ищем угрозу
const SE_SORTIE_AFTER = 1200         // если враг топчется минуту - гарнизон выходит сам
const SE_UPKEEP_DAYS = 3             // раз в столько дней без игрока - уборка и пополнение
const SE_CAPTURE_DAYS = 7            // через столько дней захваченный форт меняет хозяина
const SE_HOSTILE_HITS = 3            // столько ударов по жителю - это нападение
const SE_HOSTILE_DAMAGE = 0.2        // или пятая часть здоровья за раз
const SE_HOSTILE_VALUE = 500         // и столько медяков урона постройкам или краж

function seLog(t) { try { console.log("[жители] " + t) } catch (e) { } }
function seErr(w, e) { try { console.error("[жители] " + w + ": " + e) } catch (err) { } }
function sePick(list) { return list[Math.floor(Math.random() * list.length)] }
function seRun(cmd) { try { return Number(SE_SERVER.runCommandSilent(cmd)) } catch (e) { seErr("команда", e); return 0 } }

// ─── Хранение ────────────────────────────────────────────────────────────────

/**
 * Данные жителей. Однажды в них попало «не число» (NaN): Rhino записал его в JSON как есть, чтение падало,
 * а прежний код отдавал пустой список - и чистка (seSweep, seStale) убирала из мира всех жителей, а первое
 * же сохранение затёрло бы данные. Теперь: NaN/Infinity при чтении - null; не читается и так - данные
 * НЕ трогаем (SE_BROKEN: запись и чистка стоят), пишем в лог. При удачной загрузке - резервная копия.
 */
var SE_BROKEN = false

function seLoad() {
    if (SE_DATA) return SE_DATA
    if (!SE_SERVER) return { villages: {} }
    var raw = global.TFG_STORE.read(SE_SERVER.persistentData, "tfg_settlers") || "{}"
    try { SE_DATA = JSON.parse(raw) }
    catch (e) {
        try {
            SE_DATA = JSON.parse(String(raw).replace(/([:\[,])\s*-?(NaN|Infinity)(?=\s*[,\]}])/g, "$1null"))
            seLog("данные жителей: в записи было «не число» (NaN) - починено при чтении, поселений " + Object.keys(SE_DATA.villages || {}).length)
        } catch (e2) {
            SE_BROKEN = true
            SE_DATA = { villages: {} }
            seErr("чтение - данные не читаются; запись и чистка жителей остановлены, чтобы не затереть их", e2)
        }
    }
    if (!SE_DATA.villages) SE_DATA.villages = {}
    if (!SE_BROKEN && Object.keys(SE_DATA.villages).length) {
        try { global.TFG_STORE.write(SE_SERVER.persistentData, "tfg_settlers_backup", JSON.stringify(SE_DATA, seJsonSafe)) } catch (e3) { }
    }
    return SE_DATA
}

/** Для JSON.stringify: «не число» и бесконечность - null (Rhino пишет их как NaN, и чтение падает). */
function seJsonSafe(k, v) { return (typeof v === "number" && !isFinite(v)) ? null : v }

function seSave() {
    if (!SE_SERVER || !SE_DATA || SE_BROKEN) return
    var bad = global.TFG_STORE.write(SE_SERVER.persistentData, "tfg_settlers", JSON.stringify(SE_DATA, seJsonSafe))
    if (bad) seErr("запись", bad)         // молчать нельзя: иначе поселение станет неубираемым
}

/**
 * Улица, на которой стоит поселение. Если её запись пропала (улицу снесли через
 * /tfgstreet remove), поселение - призрак: его койки указывают на здания, которых
 * больше нет, жители появляются внутри вернувшегося рельефа и не могут сделать ни шага.
 * Именно так и вышло на сервере: spawn трижды попал в старые записи, а новое поселение
 * на 31 койку так и осталось пустым.
 */
function seStreet(v) {
    try { return global.TFG_STREET.list()[v.settlement] || null } catch (e) { return null }
}

function seGhost(v) { return !seStreet(v) }

/** Убрать поселение целиком: жителей из мира, запись из данных. */
function seDrop(v, why) {
    try { seDespawn(v) } catch (e) { }
    // клады поселения уходят вместе с ним: казна и тайники откатываются (зоны stashes.js)
    try {
        if (v.treasury && v.treasury.placed && v.treasury.zone) global.TFG_ZONES.restore(v.treasury.zone, "поселение снесли")
        var st = v.stashes || {}
        for (var k in st) if (st[k].placed && !st[k].gone && st[k].zone) global.TFG_ZONES.restore(st[k].zone, "поселение снесли")
    } catch (e) { seErr("откат кладов", e) }
    var data = seLoad()
    delete data.villages[v.id]
    seSave()
    seLog("поселение " + v.id + " удалено: " + why)
}

// ─── Роли и облик ────────────────────────────────────────────────────────────

const SE_ROLES = {
    "правитель": { garrison: false, sleeps: "ночь", speed: 0.9, hp: 40, armor: null, weapon: "@меч" },
    "крестьянин": { garrison: false, sleeps: "ночь", speed: 0.95, hp: 20, armor: null, weapon: null },
    "охотник": { garrison: false, sleeps: "ночь", speed: 1.05, hp: 24, armor: null, weapon: "лук" },
    "лесоруб": { garrison: false, sleeps: "ночь", speed: 1.0, hp: 24, armor: null, weapon: "@топор" },
    "рыцарь": { garrison: true, sleeps: "смена", speed: 0.95, hp: 44, armor: "black_steel", weapon: "@меч" },
    "стрелок": { garrison: true, sleeps: "смена", speed: 1.0, hp: 32, armor: "steel", weapon: "ствол" },
    "дружинник": { garrison: true, sleeps: "ночь", speed: 1.0, hp: 28, armor: "bronze", weapon: "@меч" },
    "бард": { garrison: false, sleeps: "ночь", speed: 0.95, hp: 20, armor: null, weapon: null },
    "торговец": { garrison: false, sleeps: "ночь", speed: 0.9, hp: 24, armor: null, weapon: "@нож" },
}

// Кого селить в домах. В форте живёт только стража, поэтому здесь её нет вовсе:
// раньше список начинался с рыцарей и стрелков, они за стенами превращались в
// дружинников - и всё поселение выходило из одних ополченцев без ремесла.
const SE_SLUM_ROLES = ["крестьянин", "крестьянин", "охотник", "лесоруб"]
const SE_ROLE_ORDER = ["крестьянин", "охотник", "лесоруб", "крестьянин", "бард", "торговец",
    "дружинник", "крестьянин", "охотник", "лесоруб", "дружинник", "крестьянин", "торговец", "дружинник"]

const SE_FEMALE_SHARE = 0.45
const SE_TRADERS_MIN = 2             // столько торговцев в поселении есть всегда
const SE_TRADE_TIER = 4              // тир товара у сельского торговца

/** Ремесло торговца: берём из тех же видов, что у приезжих гостей. */
function seTradeKind() {
    try {
        var kinds = global.TFG_TRADE_GOODS.kindsFor(SE_TRADE_TIER)
        if (kinds && kinds.length) return String(sePick(kinds).id)
    } catch (e) { }
    return "blacksmith"
}

// ─── Реплики поселения ───────────────────────────────────────────────────────

const SE_LINES = {
    "утро": ["Светает. Пора за дело.", "Роса холодная, а день длинный.", "Печь растопить бы.",
        "Петухи уже горло дерут.", "Ну, с добрым утром, работяги.", "Вода в бочке за ночь остыла.",
        "Туман над полем - к хорошему дню.", "Кто вчера ворота не закрыл?", "Пора скотину выгонять.",
        "Каша на огне, не убеги.", "Солнце встало - и я встал."],
    "день": ["Работа сама себя не сделает.", "Опять кладку подравнивать.", "Поле нынче доброе.",
        "Жарко нынче, хоть на реку беги.", "Обедать бы уже.", "Ещё грядку - и передохну.", "Глянь, какие облака.",
        "Опять гвоздей не хватает.", "Кто мой молот взял?", "Без дела сидеть - грех.",
        "Соседский пёс опять в огород залез.", "Колодец бы почистить.", "Тень от форта как раз к полудню."],
    "вечер": ["Скоро стемнеет, надо всё прибрать.", "Свечи зажечь пора.", "Ворота проверить бы.",
        "Ох, спина за день наломалась.", "Бард сегодня будет играть?", "Пора к костру.", "Скотину загнали?",
        "Вечер тихий, хорошо.", "Ужин стынет.", "Завтра опять в поле.", "Закат-то какой, гляньте."],
    "ночь": ["В такую пору честный человек спит.", "Тихо. И пусть будет тихо.", "Кто там бродит?",
        "Луна нынче яркая.", "Собаки разбрехались.", "Не спится что-то.", "Ветер воет, как волк.", "Утром разберёмся."],
    "тревога": ["Тревога! Все в форт!", "К оружию!", "Закрывай ворота!", "Бабы, детей в форт!"],
    "осада": ["Держим ворота!", "Стрелки на стены!", "Не подходи!", "За поселение!"],
    "вылазка": ["Хватит ждать. Вперёд!", "Выбьем их отсюда.", "Порядок наведём сами."],
    "отбой": ["Ушли. Слава богам.", "Раненых перевязать.", "Ворота открыть.", "Живы? Все живы?", "Собирайте стрелы.", "Пронесло."],
    "сдача": ["Довольно. Мы сдаёмся.", "Не трогайте людей.", "Забирайте, что хотите."],
    "бард": ["А ну-ка, слушайте!", "Песню? Изволь.", "За такую игру и монету не жалко.",
        "Эта - про старого рыцаря.", "Подпевайте, кто знает.", "Новая, сам сложил.", "Последняя на сегодня."],
    "бард_хвала": ["Хорошо играешь!", "Ещё, ещё!", "Душевно.", "Вот это я понимаю!", "Сыграй ещё ту, весёлую.",
        "Аж слеза пробила.", "Ну, мастер."],
    "бард_брань": ["Уймись уже.", "Опять он со своей дудкой.", "Голова от тебя болит."],
    "торг": ["Товар есть, были бы деньги.", "Смотри, не задаром.", "Бери, пока лежит.", "Подходи, не стесняйся.",
        "Скидку дам, если много возьмёшь.", "Такого больше нигде не найдёшь.", "Деньги - вперёд.", "Торговаться будем?"],
    "охота": ["Вернусь к вечеру.", "Зверь нынче пуганый.", "Мяса добуду.", "Следы свежие.", "Тише, спугнёшь.",
        "Олень ушёл к реке.", "Стрел бы побольше.", "Шкура выйдет добрая."],
    "лес": ["Дерево свалю - два посажу.", "Топор наточен.", "Брёвна сами не придут.", "Берегись, падает!",
        "Хороший ствол, ровный.", "Сосну на доски, дуб на сваи.", "Новый саженец - новый лес.", "Смола к рукам липнет."],
    // нежить у поселения - дело обычное: её гонит стража, а не всё поселение
    "монстры": ["Нежить у поля!", "Гони его!", "Не подпускай к домам.", "Я разберусь."],
    "отбой_зверь": ["Вот и всё.", "Снова лезут из леса.", "Пойду обратно."],
}

/**
 * Озвучены только те реплики, для которых в наборе гостей есть запись (kubejs/assets/tfg_voice).
 * Своих записей у жителей нет, поэтому к каждому случаю подбираем подходящие по смыслу
 * строки из готового набора - тогда житель не только пишет, но и говорит вслух.
 */
const SE_VOICE_WORDS = {
    "утро": ["утро", "рассвет", "светает", "роса"],
    "день": ["работ", "дело", "руки", "поле", "зерн", "спина", "дров"],
    "вечер": ["вечер", "стемне", "темне", "свеч", "прибрать"],
    "ночь": ["ночь", "спать", "сон", "устал", "темн"],
    "тревога": ["тревог", "оружи", "берегись", "враг", "к бою"],
    "осада": ["держ", "ворота", "стен", "не подход"],
    "вылазка": ["вперёд", "вперед", "бей", "гони", "хватит"],
    "отбой": ["ушли", "тихо", "спокой", "слава"],
    "сдача": ["сдаёмся", "сдаемся", "довольно", "не трогай"],
    "бард": ["песн", "играй", "дудк", "слуша"],
    "бард_хвала": ["хорош", "душевн", "ещё", "еще"],
    "торг": ["цен", "товар", "купи", "прода", "монет"],
    "охота": ["зверь", "охот", "мяс", "волк", "кабан", "олен"],
    "лес": ["топор", "дерев", "брёвн", "бревн", "дров", "лес"],
    "монстры": ["нежит", "зомби", "мертв", "мёртв", "твар", "гони"],
    "отбой_зверь": ["ушли", "тихо", "вот и"],
}
var SE_VOICED = null

function seVoicedPool(key) {
    if (!SE_VOICED) {
        SE_VOICED = {}
        try {
            for (var k in SE_VOICE_WORDS) SE_VOICED[k] = []
            for (var text in GS_VOICE_TEXTS) {
                var low = String(text).toLowerCase()
                if (low.charAt(0) === "*") continue                 // это не речь, а звук
                for (var key2 in SE_VOICE_WORDS) {
                    var words = SE_VOICE_WORDS[key2]
                    for (var i = 0; i < words.length; i++) {
                        if (low.indexOf(words[i]) >= 0) { SE_VOICED[key2].push(text); break }
                    }
                }
            }
            var counts = []
            for (var k2 in SE_VOICED) counts.push(k2 + " " + SE_VOICED[k2].length)
            seLog("озвученных реплик подобрано: " + counts.join(", "))
        } catch (e) { seErr("подбор озвучки", e) }
    }
    return SE_VOICED[key] || []
}

// в эти часы житель может вместо своей строки пересказать весть округи
const SE_GOSSIP_KEYS = { "день": true, "вечер": true, "торг": true }
const SE_GOSSIP_CHANCE = 0.25

function seSay(village, key, x, y, z) {
    // Говорит житель СВОИМИ словами. Чужие озвученные строки берём только там,
    // где своих нет вовсе, - подменять ими написанное для поселения нельзя.
    var pool = SE_LINES[key]
    if (!pool || !pool.length) pool = seVoicedPool(key)
    if (!pool || !pool.length) return
    // давно не звучавшая (factions/guests.js, gsPickFresh): одна фраза - не чаще раза в полчаса
    var text = typeof gsPickFresh === "function" ? gsPickFresh(pool, null) : sePick(pool)
    // в спокойный час житель иногда пересказывает весть округи (молва, lore.js)
    if (SE_GOSSIP_KEYS[key] && Math.random() < SE_GOSSIP_CHANCE) {
        try { text = global.TFG_LORE.villageLine(SE_SERVER.overworld(), village) || text } catch (e) { }
    }
    // Реплика висит над головой того, кто её сказал, и звучит голосом - как у гостей.
    // В чат поселение не пишет: спам в чате жизнью не выглядит.
    var who = null, bestD = 1e9
    try {
        seEntities(SE_SERVER.overworld(), village).forEach(e => {
            var dx = e.getX() - x, dz = e.getZ() - z
            var d = dx * dx + dz * dz
            if (d < bestD) { bestD = d; who = e }
        })
    } catch (e) { }
    if (who && seVoice(who, text)) return
    seRun("execute in " + village.dim + " positioned " + Math.round(x) + " " + Math.round(y) + " " + Math.round(z) +
        " as @a[distance=..32] run tellraw @s {\"text\":\"" + text + "\",\"color\":\"gray\",\"italic\":true}")
}

// ─── Койки: сколько коек, столько и жителей ──────────────────────────────────

/** Найти в постройках поселения изголовья кроватей: это и есть места жителей. */
function seFindBeds(level, street) {
    var beds = []
    // на вход принимаем и саму запись поселения, и её идентификатор
    if (typeof street === "string") {
        try { street = global.TFG_STREET.list()[street] } catch (e) { street = null }
    } else if (street && street.settlement) {
        try { street = global.TFG_STREET.list()[street.settlement] || street } catch (e) { }
    }
    if (!street || !street.buildings) return beds
    street.buildings.forEach(b => {
        var isFort = b.type === "форт"
        for (var x = b.x; x < b.x + b.size[0]; x++) {
            for (var z = b.z; z < b.z + b.size[2]; z++) {
                for (var y = b.y; y < b.y + b.size[1] + 2; y++) {
                    var st = ""
                    try { st = String(level.getBlock(x, y, z).getBlockState()) } catch (e) { continue }
                    if (st.indexOf("_bed") < 0 || st.indexOf("part=head") < 0) continue
                    beds.push({ x: x, y: y, z: z, building: b.type, fort: isFort })
                }
            }
        }
    })
    return beds
}

// ─── Свой сундук и сословие (этап 0 плана NPC: Downloads/TFG-NPC-план.md) ──────

const SE_ItemHandler = Java.loadClass("net.minecraftforge.common.capabilities.ForgeCapabilities").ITEM_HANDLER
/** Что считаем личным хранилищем: сундуки, ящики, шкафы; бочки - нет (в них соленья и жидкость). */
const SE_CHEST_RE = /(chest|crate|cabinet|drawer|wardrobe|cupboard|desk|trunk)/
const SE_CHEST_REACH = 12           // дальше этого от койки сундук уже не его

/** Хранилища в постройке: блок с инвентарём хотя бы в 9 ячеек. */
function seFindChests(level, b) {
    var out = []
    for (var x = b.x; x < b.x + b.size[0]; x++) {
        for (var z = b.z; z < b.z + b.size[2]; z++) {
            for (var y = b.y; y < b.y + b.size[1] + 2; y++) {
                var block = null, id = ""
                try { block = level.getBlock(x, y, z); id = String(block.getId()) } catch (e) { continue }
                if (!SE_CHEST_RE.test(id) || id.indexOf("barrel") >= 0) continue
                var ok = false
                try {
                    var be = block.getEntity()
                    if (be) {
                        var cap = be.getCapability(SE_ItemHandler).resolve()
                        ok = cap.isPresent() && Number(cap.get().getSlots()) >= 9
                    }
                } catch (e) { }
                if (ok) out.push({ x: x, y: y, z: z })
            }
        }
    }
    return out
}

/** Каждому жителю - свой сундук: ближайший к его койке в том же доме, у каждого свой. Сколько раздали. */
function seAssignChests(level, street, settlers) {
    if (!street || !street.buildings) return 0
    var taken = {}, n = 0
    settlers.forEach(s => { if (s.chest) taken[s.chest.x + "," + s.chest.y + "," + s.chest.z] = true })
    street.buildings.forEach(b => {
        var inside = s => s.bed && s.bed.x >= b.x && s.bed.x < b.x + b.size[0] && s.bed.z >= b.z && s.bed.z < b.z + b.size[2]
        var people = settlers.filter(s => !s.chest && !s.dead && inside(s))
        if (!people.length) return
        var chests = seFindChests(level, b)
        // правитель выбирает первым и ищет вдвое дальше: в особняке людей много, а без сундука у него
        // нет ни дневника, ни записей о казне
        people.sort((a, c) => (c.role === "правитель" ? 1 : 0) - (a.role === "правитель" ? 1 : 0))
        people.forEach(s => {
            var reach = s.role === "правитель" ? SE_CHEST_REACH * 2 : SE_CHEST_REACH
            var best = null, bd = reach * reach
            chests.forEach(c => {
                if (taken[c.x + "," + c.y + "," + c.z]) return
                var d = Math.pow(c.x - s.bed.x, 2) + Math.pow(c.y - s.bed.y, 2) + Math.pow(c.z - s.bed.z, 2)
                if (d < bd) { bd = d; best = c }
            })
            if (!best) return
            taken[best.x + "," + best.y + "," + best.z] = true
            s.chest = best
            n++
        })
    })
    return n
}

// ─── Караванщики родом из поселения ──────────────────────────────────────────

/**
 * Караван поселения берёт своих: торговца и дружинников (рыцари стерегут форт). Пока караван в пути,
 * их дома нет, но койка и сундук остаются за ними. Отдаёт [{ id, name, role, female }].
 */
function seCrewOut(vid, visitId, guards) {
    var v = seLoad().villages[vid]
    if (!v) return []
    var free = v.settlers.filter(s => !s.dead && !s.away)
    var out = free.filter(s => s.role === "торговец").slice(0, 1)
        .concat(free.filter(s => s.role === "дружинник" || s.role === "стрелок").slice(0, Math.max(0, guards)))
    if (!out.length) return []
    out.forEach(s => { s.away = String(visitId) })
    if (v.spawned) {
        try {
            seEntities(SE_SERVER.overworld(), v).forEach(e => {
                var sid = seTagValue(e, "tfg_sid_")
                if (out.some(s => s.id === sid)) e.discard()
            })
        } catch (e) { }
    }
    seSave()
    seLog("поселение " + v.id + ": с караваном " + visitId + " ушли " + out.map(s => s.name).join(", "))
    return out.map(s => ({ id: s.id, name: s.name, role: s.role, female: !!s.female }))
}

/** Караван кончился: кто жив - домой (если поселение вышло - появляется у своей койки). */
function seCrewHome(visitId) {
    var data = seLoad()
    for (var vid in data.villages) {
        var v = data.villages[vid]
        var back = v.settlers.filter(s => s.away === String(visitId))
        if (!back.length) continue
        back.forEach(s => {
            delete s.away
            if (v.spawned && !s.dead) try { seSpawnOne(v, s, SE_SERVER.overworld()) } catch (e) { }
        })
        seSave()
        seLog("поселение " + v.id + ": караван " + visitId + " вернулся, домой " + back.filter(s => !s.dead).length)
    }
}

/** Караванщик погиб в пути - в поселении его больше нет (на его место потом придут новые). */
EntityEvents.death(event => {
    try {
        var e = event.entity
        if (!e || !e.getTags || !e.getTags().contains("tfg_crew")) return
        var vid = String(e.persistentData.getString("tfg_crew_v")), sid = String(e.persistentData.getString("tfg_crew_sid"))
        var v = seLoad().villages[vid]
        if (!v) return
        v.settlers.forEach(s => { if (s.id === sid) { s.dead = true; delete s.away } })
        seSave()
        seLog("караванщик " + sid + " из " + vid + " погиб в пути")
    } catch (err) { seErr("смерть караванщика", err) }
})

/** Сословие: знать (правитель и живущие в особняке - приближённые, богатые торговцы), военные, простолюдины. */
const SE_ESTATE = { "правитель": "знать", "рыцарь": "военные", "стрелок": "военные", "дружинник": "военные" }
function seEstateOf(s) {
    if (!s) return "простолюдины"
    if (SE_ESTATE[s.role]) return SE_ESTATE[s.role]
    if (String(s.home || "").indexOf("особняк") === 0) return "знать"
    return "простолюдины"
}

// ─── Создание поселения жителей ──────────────────────────────────────────────

function seMake(level, streetId, owner, wantFaction, roster) {
    if (!SE_SERVER) SE_SERVER = level.getServer()
    var street = null
    try { street = global.TFG_STREET.list()[streetId] } catch (e) { }
    if (!street) return "нет такого поселения: " + streetId
    var data = seLoad()
    var fort = street.buildings.filter(b => b.type === "форт")[0]
    var cx = fort ? fort.x + fort.size[0] / 2 : street.x
    var cz = fort ? fort.z + fort.size[2] / 2 : street.z

    // Одна улица - одно поселение. Прежнюю запись сносим вместе с её жителями,
    // иначе рядом копятся призраки и spawn попадает в них, а не в новое поселение.
    for (var oldId in data.villages) {
        if (data.villages[oldId].settlement !== streetId) continue
        seDrop(data.villages[oldId], "на этой улице делается новое поселение")
    }

    var beds = seFindBeds(level, street)
    // коек может не быть вовсе: тогда селим по одному на постройку, чтобы было с чем работать
    if (!beds.length) {
        street.buildings.forEach(b => {
            beds.push({ x: Math.round(b.x + b.size[0] / 2), y: b.y + 2, z: Math.round(b.z + b.size[2] / 2),
                building: b.type, fort: b.type === "форт" })
        })
    }

    // Правитель селится не в форте, а в самом богатом доме: особняк, иначе большой дом.
    var rulerBed = -1
    var wish = ["особняк", "большой", "дом", "малый"]
    for (var wi = 0; wi < wish.length && rulerBed < 0; wi++) {
        for (var bi = 0; bi < beds.length; bi++) {
            if (!beds[bi].fort && String(beds[bi].building).indexOf(wish[wi]) === 0) { rulerBed = bi; break }
        }
    }
    if (rulerBed < 0) rulerBed = 0

    // Состав, определённый заранее (factions/world.js): правитель и торговцы известны
    // поимённо задолго до того, как игрок дойдёт до поселения. Раскладываем их по койкам:
    // стража - в форт, правитель - в богатый дом, остальные по порядку.
    var plan = null
    if (roster && roster.length) {
        plan = { fort: [], ruler: null, rest: [] }
        roster.forEach(p => {
            if (p.role === "правитель" && !plan.ruler) plan.ruler = p
            else if (p.role === "рыцарь" || p.role === "стрелок") plan.fort.push(p)
            else plan.rest.push(p)
        })
    }

    var settlers = []
    var roleIdx = 1                                   // ноль в списке занят правителем
    var fortIdx = 0
    beds.forEach((bed, i) => {
        var role, planned = null
        if (plan) {
            if (i === rulerBed && plan.ruler) { planned = plan.ruler; plan.ruler = null }
            else if (bed.fort && plan.fort.length) planned = plan.fort.shift()
            else if (plan.rest.length) planned = plan.rest.shift()
            else if (plan.fort.length) planned = plan.fort.shift()
        }
        if (planned) role = planned.role
        else if (i === rulerBed) role = "правитель"
        else if (bed.fort) {
            role = fortIdx % 2 === 0 ? "рыцарь" : "стрелок"          // в форте живёт стража
            fortIdx++
        } else if (bed.building === "трущобы") {
            // в хибарах - беднота: кормятся землёй, охотой и лесом
            role = SE_SLUM_ROLES[roleIdx % SE_SLUM_ROLES.length]
            roleIdx++
        } else {
            role = SE_ROLE_ORDER[roleIdx % SE_ROLE_ORDER.length]
            roleIdx++
            if (role === "правитель") role = "крестьянин"            // правитель всегда один
            if (role === "рыцарь" || role === "стрелок") role = "дружинник"
        }
        var female = planned ? !!planned.female : Math.random() < SE_FEMALE_SHARE
        // смена стражи считается по счёту внутри роли: иначе все рыцари оказываются
        // в одной смене, а все стрелки - в другой
        var sameRole = settlers.filter(x => x.role === role).length
        settlers.push({
            id: "n" + i, role: role, female: female, shift: sameRole % 2 === 0,
            name: planned ? planned.name : seName(role, female),
            person: planned ? planned.id : null,           // кто это в записи мира
            trade: planned ? planned.trade : null,
            bed: { x: bed.x, y: bed.y, z: bed.z },
            home: bed.building, uuid: null, state: "дома", hp: SE_ROLES[role].hp,
        })
    })

    // Торговцы в поселении обязательны: без них некуда деть добычу и не у кого
    // взять недостающее. Если список ролей их не дал - переводим в торговцы тех,
    // кого не жалко: сперва дружинников, потом лишних крестьян.
    var haveTraders = settlers.filter(x => x.role === "торговец").length
    for (var ti = 0; ti < settlers.length && haveTraders < SE_TRADERS_MIN; ti++) {
        var cand = settlers[ti]
        if (cand.person) continue                          // этот человек определён миром, роль не меняем
        if (beds[ti] && beds[ti].fort) continue
        // Крестьянина трогаем последним и только если он не единственный: поле важнее лавки.
        if (cand.role === "крестьянин") {
            if (settlers.filter(x => x.role === "крестьянин").length < 2) continue
        } else if (cand.role !== "дружинник") continue
        cand.role = "торговец"
        cand.name = seName("торговец", cand.female)
        cand.hp = SE_ROLES["торговец"].hp
        haveTraders++
    }
    // ремесло каждому торговцу: по нему собирается товар в меню
    settlers.forEach(x => { if (x.role === "торговец" && !x.trade) x.trade = seTradeKind() })

    // Поселение принадлежит одной из фракций сборки - без этого жители ничьи,
    // и ни вражда, ни торговля не работают.
    var faction = "ash"
    try {
        var list = global.TFG_FACTIONS.list.filter(f => f.id !== "bandits")
        if (list.length) faction = sePick(list).id
    } catch (e) { }
    if (street.faction) faction = street.faction
    if (wantFaction) faction = wantFaction

    var chests = 0
    try { chests = seAssignChests(level, street, settlers) } catch (e) { seErr("сундуки жителей", e) }

    var id = "v" + Number(level.getTime()) + "_" + Math.floor(Math.random() * 100000)
    while (data.villages[id]) id = "v" + Number(level.getTime()) + "_" + Math.floor(Math.random() * 100000)
    data.villages[id] = {
        id: id, dim: String(level.getDimension()), settlement: streetId,
        x: Math.round(cx), z: Math.round(cz), ring: street.ring || 28,
        faction: faction, owner: owner || null,
        settlers: settlers, beds: beds.length,
        state: "мир", alarmAt: 0, sortieAt: 0, surrenderAt: 0, capturedBy: null, capturedAt: 0,
        lastUpkeep: Number(level.getTime()), threat: {}, spawned: false, chestsDone: true,
    }
    seSave()
    seLog("поселение " + id + ": жителей " + settlers.length + " (коек " + beds.length + "), своих сундуков " + chests)
    return data.villages[id]
}

var SE_NAMES_M = ["Бран", "Хальв", "Торд", "Гуннар", "Ивар", "Сигурд", "Эйнар", "Олаф", "Рагнар", "Хакон",
    "Ульф", "Бьёрн", "Кетиль", "Свен", "Арн"]
var SE_NAMES_F = ["Астрид", "Сигрид", "Хельга", "Ингрид", "Тора", "Фрейя", "Гудрун", "Ранди", "Сольвейг", "Ирса",
    "Милена", "Агата", "Ядвига", "Злата", "Вера", "Леся", "Марта", "Ольга", "Дарина", "Беата", "Ружена", "Ванда",
    "Любава", "Эльза", "Маргит", "Илона", "Йоханна", "Катарина", "Нелли", "Северина"]

function seName(role, female) {
    // Общий список имён (npc_names.js) - мужской. Раньше он подставлялся и женщинам, и
    // выходили «Мирко · Певунья»: имя мужское, слово роли - женское.
    if (female) return sePick(SE_NAMES_F)
    var base = sePick(SE_NAMES_M)
    try {
        var given = global.TFG_NPC.guardName()
        if (given) base = String(given)
    } catch (e) { }
    return base
}

// ─── Появление и удаление жителей ────────────────────────────────────────────

// слово в имени, по которому ETF выбирает скин
const SE_SKIN_WORD = {
    "правитель": "Правитель", "крестьянин": "Крестьянин", "охотник": "Охотник", "лесоруб": "Лесоруб",
    "рыцарь": "Рыцарь", "стрелок": "Стрелок", "дружинник": "Дружинник", "бард": "Бард", "торговец": "Торговец",
}
const SE_SKIN_WORD_F = {
    "крестьянин": "Крестьянка", "торговец": "Торговка", "бард": "Певунья", "охотник": "Охотница",
}
function seSkinWord(role, female) {
    if (female && SE_SKIN_WORD_F[role]) return SE_SKIN_WORD_F[role]
    return SE_SKIN_WORD[role] || "Крестьянин"
}

// цвет имени по фракции: свои узнаются с первого взгляда
const SE_FACTION_COLOR = { ash: "gold", wind: "aqua", marvins: "green", alliance: "light_purple", bandits: "dark_red" }
function seFactionColor(f) { return SE_FACTION_COLOR[f] || "white" }

// ─── Гардероб (одежда TFC Textile) ───────────────────────────────────────────
//
// Мирные жители ходят в одежде, а не в броне: по ней и отличаются. Набор закрепляется за
// жителем по его номеру. Порядок в наборе - ноги, штаны, рубаха, голова; null - ничего.
// Стража (рыцари, стрелки, дружина) остаётся в доспехах.

const SE_WEAR_VERSION = 3            // поднять - и все жители переоденутся при следующей загрузке (2 - новые вещи, 3 - украшения)
const SE_FURS = ["caribou", "direwolf", "black_bear", "grizzly_bear", "cougar"]
const SE_RICH_FURS = ["lion", "tiger", "panther", "polar_bear"]

function seHashStr(str) {
    var h = 7
    var s = String(str)
    for (var i = 0; i < s.length; i++) h = (h * 131 + s.codePointAt(i)) % 2147483647
    for (var k = 0; k < 2; k++) h = (h * 48271) % 2147483647
    return h
}

/** Одежда по роли: [ноги, штаны, рубаха, голова] - id предметов или null.
 *  Новые вещи сборки (шубы tfgui, CosmeticArmours, Villager Clothes) - в обычных слотах: гардероба у NPC нет. */
function seWardrobe(role, key, female, rank, faction) {
    var h = seHashStr(key)
    var pick = (list, salt) => list[(seHashStr(key + "|" + salt)) % list.length]
    var T = "tfc_textile:", CA = "cosmeticarmoursmod:", VC = "villager_clothes:"
    if (role === "правитель") {
        var rich = pick(SE_RICH_FURS, "fur")
        var col = pick(["red", "purple", "blue", "black"], "col")
        // венец по достатку: на хуторе, в деревне и селе - диадема (украшение, seJewels), в городе - корона,
        // в полисе - императорская корона цвета фракции
        var crown = null
        if (rank === 3) crown = female ? pick(["diamond_adorned_tiara_helmet", "emerald_adorned_tiara_helmet"], "crown")
            : pick(["diamond_crown_helmet", "emerald_crown_helmet"], "crown")
        if (rank >= 4) crown = "imperial_crown_" + (SE_CROWN_DYE[seFactionColor(faction)] || "purple") + "_helmet"
        return [CA + "emperors_attire_" + col + "_boots", "tfgui:fur_coat_legs_" + rich, "tfgui:fur_coat_" + rich,
            crown ? CA + crown : null]
    }
    if (role === "торговец") return [T + "crocodile_boots", T + "linen_pants", VC + "cartographer_chestplate", VC + "cartographer_helmet"]
    if (role === "охотник") {
        var c = pick(["green", "orange", "red", "blue"], "col")
        return [CA + "archers_attire_boots", CA + "archers_attire_leggings", CA + c + "_archers_attire_chestplate",
            h % 2 ? CA + c + "_archers_attire_helmet" : null]
    }
    if (role === "лесоруб") {
        return [T + pick(["direwolf_boots", "black_bear_boots", "grizzly_bear_boots"], "boots"), VC + "taiga_leggings",
            VC + "taiga_chestplate", h % 2 ? VC + "taiga_helmet" : null]
    }
    if (role === "бард") {
        var bc = pick(["red", "blue", "green", "purple", "orange"], "col")
        return female ? [CA + bc + "_plaid_skirt_boots", CA + bc + "_plaid_skirt_leggings", CA + "royal_tunic_" + bc + "_chestplate", null]
            : [T + "cotton_socks", T + "linen_pants", CA + "royal_tunic_" + bc + "_chestplate", T + "cotton_hat"]
    }
    if (role === "крестьянин") {
        if (female) {
            var sc = pick(["brown", "grey", "green", "light_grey"], "col")
            return [CA + sc + "_skirt_boots", CA + sc + "_skirt_leggings", CA + sc + "_skirt_chestplate",
                h % 3 === 0 ? CA + pick(["maid_bonnet_black_helmet", "maid_bonnet_blue_helmet"], "hat") : null]
        }
        var job = pick(["farmer", "shepherd", "fisherman", "butcher", "mason", "leatherworker", "plains"], "job")
        var hat = { farmer: VC + "farmer_helmet", shepherd: VC + "shepherd_helmet", fisherman: VC + "fisherman_helmet", butcher: VC + "butcher_helmet" }[job]
        return [T + pick(["cotton_socks", "raw_socks", "linen_socks"], "boots"),
            job === "plains" ? VC + "plains_leggings" : T + pick(["cotton_pants", "linen_pants"], "pants"),
            VC + job + "_chestplate", hat && h % 2 ? hat : null]
    }
    return null                                       // стража - в доспехах
}

// ─── Украшения жителей ───────────────────────────────────────────────────────
//
// Достаток поселения (0 хутор, 1 деревня, 2 село, 3 город, 4 полис) - по силе (числу жителей) и
// зажиточности улицы. От него - металл и огранка украшений: на хуторе медь без камней, в полисе
// платина и изысканные камни. Правитель носит полный набор и венец, торговец и бард - победнее,
// крестьянки - серьги в зажиточных местах. Украшений у NPC в слотах нет: их список лежит в рубахе
// жителя (тег tfgui_jewels), а рисует их мод tfgui поверх модели - так же, как у игрока.

const SE_RANK_NAMES = ["хутор", "деревня", "село", "город", "полис"]
// императорская корона - цвета фракции
const SE_CROWN_DYE = { gold: "yellow", aqua: "light_blue", green: "green", light_purple: "magenta", dark_red: "red", white: "purple" }
// металл и огранка украшений по достатку; "-" - без камней
const SE_JEWEL_CLASS = [
    { metals: ["copper", "bronze", "brass"], grades: ["-", "regular"], sides: false },
    { metals: ["silver", "sterling_silver", "bronze", "brass"], grades: ["regular"], sides: false },
    { metals: ["silver", "sterling_silver", "rose_gold", "gold"], grades: ["regular", "flawless"], sides: true },
    { metals: ["gold", "rose_gold"], grades: ["flawless", "exquisite"], sides: true },
    { metals: ["gold", "platinum"], grades: ["exquisite"], sides: true },
]
var SE_JEWEL_POOL = null                 // "вид|достаток" -> id украшений

/** Достаток поселения 0..4. */
function seProsperity(village) {
    if (!village) return 1
    var wealth = 1
    try {
        var st = village.settlement ? global.TFG_STREET.list()[village.settlement] : null
        if (st && st.wealth !== undefined) wealth = Number(st.wealth)
    } catch (e) { }
    var pts = (seVillageTier(village) - 4) / 1.5 + wealth - 1
    return Math.max(0, Math.min(4, Math.round(pts)))
}

/** Украшения этого вида по достатку (без tfgui:). */
function seJewelPool(kind, rank) {
    if (!SE_JEWEL_POOL) {
        SE_JEWEL_POOL = {}
        var ids = []
        try { ids = global.TFG_JEWEL_IDS || [] } catch (e) { }
        ids.forEach(id => {
            var p = String(id).split("/")                 // jewel/<вид>/<металл>[/<огранка>/<центр>[/<бока>]]
            for (var r = 0; r < SE_JEWEL_CLASS.length; r++) {
                var c = SE_JEWEL_CLASS[r]
                if (c.metals.indexOf(p[2]) < 0) continue
                if (c.grades.indexOf(p.length > 3 ? p[3] : "-") < 0) continue
                // в богатых местах - с боковой парой, где она бывает (у колец, серёг и фибул её нет)
                if (c.sides && p.length > 3 && p.length < 6 && !/^(ring|earrings|brooch)$/.test(p[1])) continue
                var key = p[1] + "|" + r
                ;(SE_JEWEL_POOL[key] = SE_JEWEL_POOL[key] || []).push(String(id))
            }
        })
    }
    return SE_JEWEL_POOL[kind + "|" + rank] || []
}

/** Набор украшений жителя: id без tfgui: (кольца - первое на левой руке, второе на правой). */
function seJewels(role, key, female, rank, hasHat) {
    var out = []
    var add = (kind, r, salt) => {
        if (r < 0) return
        var pool = seJewelPool(kind, Math.min(4, r))
        if (pool.length) out.push(pool[seHashStr(key + "|j|" + salt) % pool.length])
    }
    if (role === "правитель") {
        if (rank <= 2 && !hasHat) add("diadem", rank, "diadem")
        add("necklace", rank, "neck")
        if (female) add("earrings", rank, "ear")
        if (rank >= 1) add(female ? "bracelet" : "brooch", rank, "b")
        if (rank >= 2) add("ring", rank, "ring1")
        if (rank >= 3) { add("ring", rank, "ring2"); add(female ? "brooch" : "bracelet", rank, "b2") }
    } else if (role === "торговец") {
        if (rank >= 1) add("ring", rank - 1, "ring1")
        if (rank >= 2) add("brooch", rank - 1, "brooch")
        if (rank >= 3) add("necklace", rank - 1, "neck")
    } else if (role === "бард") {
        if (rank >= 1) add(female ? "earrings" : "brooch", rank - 1, "a")
        if (rank >= 2) add(female ? "necklace" : "ring", rank - 1, "b")
    } else if (role === "крестьянин" && female) {
        if (rank >= 2) add("earrings", rank - 2, "ear")
        if (rank >= 4) add("bracelet", rank - 2, "br")
    }
    return out
}

/** Переодеть жителя по гардеробу (и уже живущих - при загрузке чанка). */
function seDress(e) {
    var role = seRoleOf(e)
    var female = false, rank = 1, vr = null
    try {
        var vid = seTagValue(e, "tfg_v_"), sid = seTagValue(e, "tfg_sid_")
        vr = vid && seLoad().villages[vid]
        var rec = vr && vr.settlers.filter(x => x.id === sid)[0]
        female = !!(rec && rec.female)
        rank = seProsperity(vr)
    } catch (err) { }
    var key = seSidOf(e) + "|" + seTagValue(e, "tfg_v_")
    var set = seWardrobe(role, key, female, rank, vr ? vr.faction : null)
    if (!set) return
    var pd = e.persistentData
    if (Number(pd.getInt("tfg_wear")) === SE_WEAR_VERSION) return
    var jewels = []
    try { jewels = seJewels(role, key, female, rank, !!set[3]) } catch (err) { seErr("украшения", err) }
    var put = (fn, id, nbt) => {
        try {
            var st = id && global.TFG_STRUCTURES.exists(id) ? (nbt ? Item.of(id, nbt) : Item.of(id)) : Item.of("minecraft:air")
            e[fn](st)
        } catch (err) { }
    }
    put("setFeetArmorItem", set[0])
    put("setLegsArmorItem", set[1])
    // украшения - тегом на рубахе: экипировка с тегами уходит клиенту, мод их и рисует
    put("setChestArmorItem", set[2], jewels.length
        ? "{tfgui_jewels:[" + jewels.map(j => "\"tfgui:" + j + "\"").join(",") + "]}" : null)
    put("setHeadArmorItem", set[3])
    pd.putInt("tfg_wear", SE_WEAR_VERSION)
}

function seArmor(metal, piece) {
    var id = "tfc:metal/" + piece + "/" + metal
    try { if (!global.TFG_STRUCTURES.exists(id)) return "{}" } catch (e) { }
    return '{id:"' + id + '",Count:1b}'
}

// ─── Боеспособность: сила поселения и снаряжение по ней ──────────────────────
//
// Сила (тир 4-10) растёт с числом жителей: большой город держит оборону лучше хутора.
// От неё зависят здоровье стражи, металл доспехов и класс стволов. Задать вручную -
// /tfgvillage power <тир> (ближайшее поселение). Стволы собираются как у налётчиков (tfgGunStack в
// primitive_creatures/bandit_roles.js) - с холостым боезапасом, и бой ведёт тот же мозг
// рейдеров, что умеет стрелять из TACZ. Раньше стрелку доставался первый ствол таблицы,
// а дружине - бронзовое копьё вместо меча, и поселение отбивалось копьями.

function seVillageTier(village) {
    if (village && village.power) return Math.max(1, Math.min(10, Number(village.power)))
    var n = village && village.settlers ? village.settlers.length : 12
    return Math.max(4, Math.min(10, 2 + Math.round(n / 3)))
}

function seMetalFor(tier) {
    if (tier <= 2) return "bronze"
    if (tier === 3) return "wrought_iron"
    if (tier <= 5) return "steel"
    if (tier <= 7) return "black_steel"
    if (tier <= 9) return "blue_steel"
    return "red_steel"
}

/** Ствол по силе поселения; simple - только пистолеты, дробовики и рычажные. */
function seGunId(tier, simple) {
    var pool = []
    try {
        for (var id in global.TFG_GUNS) {
            var g = global.TFG_GUNS[id]
            if (String(g[0]).indexOf("melee") >= 0) continue
            if (simple && !g[1]) continue
            var need = typeof tgGunTier === "function" ? tgGunTier(id, g[1]) : (g[1] ? 3 : 5)
            if (need > tier) continue
            if (!global.TFG_GUN_ITEMS.loaded(id)) continue
            pool.push(id)
        }
    } catch (e) { seErr("подбор ствола", e) }
    return pool.length ? sePick(pool) : null
}

function seGunNbt(tier, simple) {
    var id = seGunId(tier, simple)
    if (!id) return null
    var st = null
    try { if (typeof tfgGunStack === "function") st = tfgGunStack(id) } catch (e) { }
    if (!st || st.isEmpty()) st = global.TFG_GUN_ITEMS.gun(id)
    return st ? global.TFG_STRUCTURES.stackNbt(st) : null
}

function seItemNbt(id) {
    try { return global.TFG_STRUCTURES.exists(id) ? '{id:"' + id + '",Count:1b}' : null } catch (e) { return null }
}

function seSwordNbt(metal) {
    var nbt = seItemNbt("gtceu:" + metal + "_sword") || seItemNbt("gtceu:steel_sword")
    if (nbt) return nbt
    try {
        var st = global.TFG_STRUCTURES.tool("@меч")
        if (st) return global.TFG_STRUCTURES.stackNbt(st)
    } catch (e) { }
    return seItemNbt("tfc:metal/mace/" + metal) || '{id:"tfc:metal/mace/wrought_iron",Count:1b}'
}

/** Чем вооружён житель: [правая рука, левая рука] в SNBT. */
function seLoadout(role, tier) {
    var metal = seMetalFor(tier)
    var shield = seItemNbt("tfc:metal/shield/" + metal) || "{}"
    switch (role) {
        case "стрелок": return [seGunNbt(tier, false) || '{id:"minecraft:crossbow",Count:1b}', "{}"]
        case "рыцарь": return [seSwordNbt(metal), shield]
        case "дружинник": return Math.random() < 0.5
            ? [seGunNbt(tier, true) || seSwordNbt(metal), "{}"]
            : [seSwordNbt(seMetalFor(tier - 2)), seItemNbt("tfc:metal/shield/" + seMetalFor(tier - 2)) || "{}"]
        case "охотник": return [(Math.random() < 0.5 ? seGunNbt(tier, true) : null) || '{id:"minecraft:bow",Count:1b}', "{}"]
        case "правитель": return [seGunNbt(tier, true) || seSwordNbt(metal), "{}"]
        case "лесоруб":
        case "торговец": {
            try {
                var st = global.TFG_STRUCTURES.tool(role === "лесоруб" ? "@топор" : "@нож")
                if (st) return [global.TFG_STRUCTURES.stackNbt(st), "{}"]
            } catch (e) { }
            return ["{}", "{}"]
        }
        default: return ["{}", "{}"]
    }
}

/** Металл доспехов по роли: рыцарь в лучшем, стрелок на ступень ниже, дружина ещё ниже. */
function seArmorMetal(role, tier) {
    if (role === "рыцарь") return seMetalFor(tier)
    if (role === "стрелок") return seMetalFor(tier - 1)
    if (role === "дружинник") return seMetalFor(tier - 2)
    return null
}

/** Здоровье: стража и правитель крепнут с силой поселения, мирные - чуть-чуть. */
function seHealth(role, tier) {
    var base = (SE_ROLES[role] || SE_ROLES["крестьянин"]).hp
    var k = SE_FIGHTERS.indexOf(role) >= 0 || role === "правитель" ? 0.12 : 0.03
    return Math.round(base * (1 + k * Math.max(0, tier - 3)))
}

// ─── Чьё это поселение ───────────────────────────────────────────────────────

function seFactionRec(id) {
    try { return global.TFG_FACTIONS.list.filter(f => f.id === id)[0] || null } catch (e) { return null }
}

/** Цвет подписи: цвет фракции (как у её гостей и торговцев), иначе старая таблица. */
function seNameColor(factionId) {
    var f = seFactionRec(factionId)
    try { if (f && typeof trColor === "function") return String(trColor(f).text) } catch (e) { }
    return seFactionColor(factionId)
}

/** Подпись жителя: имя, роль (по ней ETF выбирает скин) и фракция. */
function seTitle(rec, factionId) {
    // у старых записей женщине досталось мужское имя - по имени и считаем: мужчина
    if (rec.female && SE_NAMES_F.indexOf(rec.name) < 0) { rec.female = false; try { seSave() } catch (e) { } }
    var f = seFactionRec(factionId)
    return rec.name + " · " + seTradeWord(rec) + (f ? " · " + f.name : "")
}

/**
 * Слово роли в подписи. У торговца - его ремесло (Кузнец, Плотник, Повар): видно издалека,
 * к кому идти, и ETF по этому же слову надевает скин ремесла (husk.properties).
 */
function seTradeWord(rec) {
    if (rec.role === "торговец" && rec.trade) {
        try {
            var k = global.TFG_TRADE_GOODS.kind(rec.trade)
            if (k && k.name) return String(k.name)
        } catch (e) { }
    }
    return seSkinWord(rec.role, rec.female)
}

/** Появление одного жителя. Возвращает uuid или null. */
// что считается проходимым: воздух, трава, цветы, снежок - всё, сквозь что можно встать
function seOpenAt(level, x, y, z) {
    var id = ""
    try { id = String(level.getBlock(Math.floor(x), Math.floor(y), Math.floor(z)).id) } catch (e) { return false }
    if (id === "minecraft:air" || id === "minecraft:cave_air") return true
    if (id.indexOf("tfc:plant/") === 0 || id.indexOf("_bed") >= 0) return true
    if (id.indexOf("minecraft:snow") === 0 || id.indexOf("grass") >= 0) return true
    return false
}

/** Можно ли встать: две клетки проходимы, а под ногами - твёрдый пол (не вода, не воздух). */
function seStandable(level, x, y, z) {
    if (!seOpenAt(level, x, y, z) || !seOpenAt(level, x, y + 1, z)) return false
    var below = ""
    try { below = String(level.getBlock(Math.floor(x), Math.floor(y) - 1, Math.floor(z)).id) } catch (e) { return false }
    return below !== "minecraft:air" && below !== "minecraft:cave_air" && below.indexOf("water") < 0 && below.indexOf("lava") < 0
}

/**
 * Место, где житель поместится. Сперва сама койка, потом клетки вокруг неё в объёме
 * (±4 по сторонам, ±2 по высоте - в доме, а не за стеной), потом у двери ближайшей
 * постройки, и лишь в крайнем случае верх столба. Раньше после трёх клеток на той же
 * высоте сразу брался верх столба - и житель появлялся на крыше.
 */
function seFreeSpot(level, bed, village) {
    if (seOpenAt(level, bed.x, bed.y, bed.z) && seOpenAt(level, bed.x, bed.y + 1, bed.z)) {
        return { x: bed.x, y: bed.y, z: bed.z, moved: false }
    }
    var dys = [0, 1, -1, 2, -2]
    for (var r = 1; r <= 4; r++) {
        for (var di = 0; di < dys.length; di++) {
            for (var dx = -r; dx <= r; dx++) {
                for (var dz = -r; dz <= r; dz++) {
                    if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue
                    var x = bed.x + dx, y = bed.y + dys[di], z = bed.z + dz
                    if (seStandable(level, x, y, z)) return { x: x, y: y, z: z, moved: true }
                }
            }
        }
    }
    // у двери ближайшей постройки, снаружи на шаг
    try {
        var st = village ? seStreet(village) : null
        var best = null, bestD = 30 * 30
        ;(st && st.buildings || []).forEach(b => {
            if (!b.door) return
            var d = Math.pow(b.door.x - bed.x, 2) + Math.pow(b.door.z - bed.z, 2)
            if (d < bestD) { bestD = d; best = b.door }
        })
        if (best) {
            var ox = best.out ? best.out.dx || 0 : 0, oz = best.out ? best.out.dz || 0 : 0
            var px = Math.round(best.x + ox * 2), pz = Math.round(best.z + oz * 2), py = Math.round(best.y)
            for (var k = 0; k < dys.length; k++) {
                if (seStandable(level, px, py + dys[k], pz)) return { x: px, y: py + dys[k], z: pz, moved: true }
            }
        }
    } catch (e) { }
    // в крайнем случае - ближайшая земля, но не крыша (factions/structures.js)
    try {
        var gsp = global.TFG_GROUND_SPOT(level, bed.x, bed.z, 16)
        if (gsp) return { x: Math.floor(gsp.x), y: gsp.y, z: Math.floor(gsp.z), moved: true }
    } catch (e) { }
    var top = bed.y
    try { top = Number(level.getHeight("WORLD_SURFACE_WG", Math.floor(bed.x), Math.floor(bed.z))) } catch (e) { }
    return { x: bed.x, y: top, z: bed.z, moved: true }
}

function seSpawnOne(village, s, level) {
    var r = SE_ROLES[s.role] || SE_ROLES["крестьянин"]
    // место ищем всегда, кто бы ни выпускал (и новых хозяев после смены - тоже): не в стене и не на крыше
    var spot = seFreeSpot(level, s.bed, village)
    // вернулся из похода: появляется на краю поселения и сам идёт домой
    if (s.enterAt) {
        try {
            var ey = Number(level.getHeight("MOTION_BLOCKING_NO_LEAVES", s.enterAt.x, s.enterAt.z))
            spot = { x: s.enterAt.x, y: ey, z: s.enterAt.z }
        } catch (err) { }
        delete s.enterAt
    }
    var x = spot.x + 0.5, y = spot.y, z = spot.z + 0.5
    // Имя решает, какой скин наденет ETF (kubejs/assets/.../zombie/husk.properties),
    // поэтому роль пишем в имени словом, которое там прописано.
    if (s.role === "торговец" && !s.trade) { s.trade = seTradeKind(); seSave() }   // ремесло нужно уже в имени
    var title = seTitle(s, village.faction)
    var color = seNameColor(village.faction)
    var name = JSON.stringify(JSON.stringify({ text: title, color: color }))
    var tier = seVillageTier(village)
    var metal = seArmorMetal(s.role, tier)
    var armor = metal
        ? [seArmor(metal, "boots"), seArmor(metal, "greaves"), seArmor(metal, "chestplate"), seArmor(metal, "helmet")]
        : ["{}", "{}", "{}", "{}"]
    var hands = seLoadout(s.role, tier)
    var hp = seHealth(s.role, tier)
    var fighter = SE_FIGHTERS.indexOf(s.role) >= 0
    // Метки без двоеточий: с ними селектор @e[tag=...] иногда не находит сущность,
    // и жители переставали убираться.
    var nbt = "{Tags:[\"tfg_npc\",\"tfg_settler\",\"tfg_v_" + village.id + "\",\"tfg_role_" + seRoleTag(s.role) +
        "\",\"tfg_sid_" + s.id + "\",\"tfg_faction_" + (village.faction || "ash") + "\"]," +
        "PersistenceRequired:1b,CanPickUpLoot:0b,DeathLootTable:\"\"," +
        "CustomName:" + name + ",CustomNameVisible:1b,Health:" + hp + "f," +
        "Attributes:[{Name:\"minecraft:generic.max_health\",Base:" + hp + "d}," +
        "{Name:\"minecraft:generic.movement_speed\",Base:" + (0.3 * r.speed).toFixed(3) + "d}," +
        "{Name:\"minecraft:generic.follow_range\",Base:" + (fighter ? 64 : 48) + "d}," +
        (fighter ? "{Name:\"minecraft:generic.attack_damage\",Base:" + (3 + 0.5 * tier).toFixed(1) + "d}," +
            "{Name:\"minecraft:generic.knockback_resistance\",Base:" + (s.role === "рыцарь" ? 0.6 : 0.2) + "d}," : "") +
        "{Name:\"minecraft:zombie.spawn_reinforcements\",Base:0d}]," +
        "ArmorItems:[" + armor.join(",") + "],ArmorDropChances:[0f,0f,0f,0f]," +
        "HandItems:[" + (hands[0] || "{}") + "," + (hands[1] || "{}") + "],HandDropChances:[0f,0f]}"
    seRun("execute in " + village.dim + " run summon minecraft:husk " + x.toFixed(2) + " " + y + " " + z.toFixed(2) + " " + nbt)
    return true
}

function seSpawn(level, village) {
    if (!SE_SERVER) SE_SERVER = level.getServer()
    if (seGhost(village)) {
        seLog("поселение " + village.id + ": улицы " + village.settlement + " больше нет - спавн отменён")
        return -1
    }
    if (!village.settlers.length) {
        seLog("поселение " + village.id + ": жителей в записи нет - спавн отменён")
        return -1
    }
    if (!village.graph || !village.graph.nodes || !village.graph.nodes.length) seBuildGraph(level, village)
    var n = 0, moved = 0
    village.settlers.forEach(s => {
        if (s.dead || s.away) return                 // ушёл с караваном - койка за ним, но дома его нет
        var spot = seFreeSpot(level, s.bed, village)
        if (spot.moved) moved++
        s.bed = { x: spot.x, y: spot.y, z: spot.z }
        if (seSpawnOne(village, s, level)) n++
    })
    if (moved) seLog("поселение " + village.id + ": коек занято рельефом " + moved + " - жителей переставил")
    village.spawned = true
    village.spawnedAt = Number(level.getTime())
    seSave()
    seLog("поселение " + village.id + ": вышло жителей " + n)
    return n
}

/**
 * Убрать жителей поселения - не убивая. Раньше их убивали (kill), и мод трупов честно оставлял на месте
 * каждого труп с именем и снаряжением: после пересборки рядом с новым правителем лежал старый. Теперь
 * сущности просто убираются из мира, а трупы жителей этого поселения (по метке tfg_v_ в их облике) - тоже.
 * Кто в непрогруженных чанках - отсеется при прогрузке (seStale в EntityEvents.spawned).
 */
function seDespawn(village) {
    var n = 0
    try {
        var level = SE_SERVER.overworld()
        seEntities(level, village).forEach(e => { if (seRemove(e)) n++ })
        seClearCorpses(level, village)
    } catch (e) { seErr("уборка жителей", e) }
    village.spawned = false
    seSave()
    return n
}

const SE_RemovalReason = Java.loadClass("net.minecraft.world.entity.Entity$RemovalReason")

/** Убрать сущность из мира без смерти (без трупа и добычи). true - убрана. */
function seRemove(e) {
    try { e.discard() } catch (err) { }
    try { if (!e.isRemoved()) e.remove(SE_RemovalReason.DISCARDED) } catch (err) { }
    try { return !!e.isRemoved() } catch (err) { return false }
}

/**
 * Чистка раз в десять секунд: житель, чьего поселения или записи больше нет, умерший по записи или
 * двойник (то же поселение и номер) - убирается. После перестройки старые жители оставались жить.
 */
function seSweep(level) {
    var data = seLoad(), seen = {}, n = 0
    if (SE_BROKEN || !Object.keys(data.villages).length) return 0   // пустой или нечитаемый список - не повод убирать всех
    try {
        var list = level.getEntities()
        for (var i = 0; i < list.size(); i++) {
            var e = list.get(i)
            if (!e || !e.getTags || !e.isAlive() || !e.getTags().contains("tfg_settler")) continue
            var vid = seTagValue(e, "tfg_v_"), sid = seTagValue(e, "tfg_sid_")
            var v = vid ? data.villages[vid] : null
            var rec = v ? v.settlers.filter(x => x.id === sid)[0] : null
            var key = vid + "|" + sid
            if (!v || !rec || rec.dead || seen[key]) { if (seRemove(e)) n++; continue }
            seen[key] = true
        }
    } catch (err) { seErr("чистка жителей", err) }
    if (n) seLog("убрано лишних жителей: " + n)
    return n
}

/** Трупы жителей поселения: облик трупа хранит метки умершего. */
function seClearCorpses(level, village) {
    var n = 0
    try {
        var list = level.getEntities()
        for (var i = 0; i < list.size(); i++) {
            var c = list.get(i)
            if (!c) continue
            try { if (String(c.getClass().getSimpleName()) !== "CorpseEntity") continue } catch (err) { continue }
            var look = null
            try { look = c.look() } catch (err) { continue }
            if (look && String(look.toString()).indexOf("tfg_v_" + village.id + "\"") >= 0) { c.discard(); n++ }
        }
    } catch (e) { seErr("уборка трупов", e) }
    if (n) seLog("поселение " + village.id + ": убрано трупов жителей " + n)
    return n
}

/**
 * Лишний житель при появлении в мире: его поселения нет, записи нет, он умер по записи или такой же
 * (то же поселение и номер) уже ходит. Так из далёких чанков не возвращаются старые жители, а правителей
 * не становится двое.
 */
function seStale(e) {
    if (SE_BROKEN) return false                       // данные не прочитались - никого не трогаем
    var vid = seTagValue(e, "tfg_v_"), sid = seTagValue(e, "tfg_sid_")
    if (!vid || !sid) return false
    var v = seLoad().villages[vid]
    if (!v) return true
    var rec = v.settlers.filter(x => x.id === sid)[0]
    if (!rec || rec.dead) return true
    var me = String(e.uuid), twin = false
    try {
        var list = e.level.getEntities()
        for (var i = 0; i < list.size() && !twin; i++) {
            var o = list.get(i)
            if (!o || String(o.uuid) === me || !o.getTags || !o.isAlive()) continue
            var tags = o.getTags()
            if (tags.contains("tfg_v_" + vid) && tags.contains("tfg_sid_" + sid)) twin = true
        }
    } catch (err) { }
    return twin
}

/**
 * Житель - не монстр. Хаск приходит с полным набором злобных целей: искать игрока,
 * бить, ломиться. Снимаем всё, как это делают стражи гостей, и заодно разрешаем
 * навигации открывать двери и не бояться воды - иначе болванчик копится в углу.
 */
// Цели, которые жителю не нужны: бродить самому, шляться по деревне, ломать двери
// и разорять черепашьи кладки. Всё остальное оставляем - драка держится на них:
// без ZombieAttackGoal поставленная цель ничего не значит (проверено на гостях).
const SE_RandomStrollGoal = Java.loadClass("net.minecraft.world.entity.ai.goal.RandomStrollGoal")
const SE_MoveThroughVillageGoal = Java.loadClass("net.minecraft.world.entity.ai.goal.MoveThroughVillageGoal")
const SE_BreakDoorGoal = Java.loadClass("net.minecraft.world.entity.ai.goal.BreakDoorGoal")

var SE_GOAL_FIELDS = null
function seGoalFields(e) {
    if (!SE_GOAL_FIELDS) {
        var c = e.getClass()
        while (c && String(c.getName()) !== "net.minecraft.world.entity.Mob") c = c.getSuperclass()
        var gf = c.getDeclaredField("f_21345_")
        var tf = c.getDeclaredField("f_21346_")
        gf.setAccessible(true)
        tf.setAccessible(true)
        SE_GOAL_FIELDS = [gf, tf]
    }
    return SE_GOAL_FIELDS
}

function seTame(e) {
    try {
        var f = seGoalFields(e)
        f[1].get(e).removeAllGoals(g => true)          // все цели "кого бить" - прочь
        f[0].get(e).removeAllGoals(g => g instanceof SE_RandomStrollGoal ||
            g instanceof SE_MoveThroughVillageGoal || g instanceof SE_BreakDoorGoal)
        e.setTarget(null)
    } catch (err) { seErr("снятие целей", err) }
    // стрелку - без рукопашной цели зомби, как у рейдеров и стражи гостей
    try { if (typeof raidSetupAi === "function") raidSetupAi(e) } catch (err) { }
    // шаг живого человека, а не зомби: базовая скорость хаска 0.23
    try { e.setAttributeBaseValue("minecraft:generic.movement_speed", 0.3) } catch (err) { }
    try {
        var nav = e.getNavigation()
        if (nav.setCanOpenDoors) nav.setCanOpenDoors(true)
        if (nav.setCanPassDoors) nav.setCanPassDoors(true)
        if (nav.setCanFloat) nav.setCanFloat(true)
    } catch (err) { }
    // голос: как у рейдеров - человеческие звуки вместо рычания
    try {
        if (typeof RAID_HUSKS !== "undefined" && String(e.type) === "minecraft:husk") {
            RAID_HUSKS[String(e.uuid)] = { e: e, sounds: ["tfg_no_sound", "entity.player.hurt", "entity.player.death"] }
        }
    } catch (err) { }
}

EntityEvents.spawned(event => {
    try {
        var e = event.entity
        // Житель-хаск, постоявший в воде, становится зомби, потом утопленником: имя «Имя · Роль · Фракция»
        // игра переносит, а метки - нет. Такой «второй правитель» поселению не нужен - пропавшего вернёт
        // seRespawnMissing у кровати. Не впускаем превращённых.
        try {
            var tp = String(e.getType())
            if (/zombie|drowned/.test(tp) && e.getTags && !e.getTags().contains("tfg_npc") && e.getCustomName() &&
                String(e.getCustomName().getString()).split(" · ").length >= 3) { event.cancel(); return }
        } catch (err0) { }
        if (!e || !e.getTags || !e.getTags().contains("tfg_settler")) return
        if (seStale(e)) { seLog("лишний житель " + String(e.getName().getString()) + " не впущен в мир"); event.cancel(); return }
        seTame(e)
        seVoiceSetup(e)
        if (seRoleOf(e) === "торговец") seTraderSetup(e)
        else seRestoreSettlerName(e)                  // подпись по нынешней записи (пол, ремесло)
        try { seDress(e) } catch (err) { seErr("гардероб", err) }
    } catch (err) { seErr("появление", err) }
})

/**
 * Сельский торговец торгует тем же меню, что и приезжий: метка tfg_trader плюс
 * данные о товаре. Ключ tfg_trader_until НЕ ставим - иначе factions/trader.js
 * заберёт его себе и поведёт прочь из деревни, а ходить он должен по-нашему.
 */
/** Тембр жителю: женщинам выше мужского, мужчинам - как у гостей. */
function seVoiceSetup(e) {
    try {
        var vid = seTagValue(e, "tfg_v_"), sid = seTagValue(e, "tfg_sid_")
        var v = vid && seLoad().villages[vid]
        var rec = v && v.settlers.filter(x => x.id === sid)[0]
        if (!rec) return
        // Голос - за человеком навсегда (запись поселения): по роли и полу, а в поселении -
        // тот, что звучит реже всего. Правитель - m0, правительница - f0 (голоса Silero, guests.js).
        if (!rec.voice) {
            var pool
            if (rec.role === "правитель") pool = rec.female ? ["f0"] : ["m0"]
            else if (SE_FIGHTERS.indexOf(rec.role) >= 0) pool = rec.female ? GS_VOICE_FEMALE : GS_VOICE_WARRIOR
            else if (rec.role === "бард") pool = rec.female ? ["f4", "f6"] : ["m3", "m6"]
            else pool = rec.female ? GS_VOICE_FEMALE : GS_VOICE_MALE
            var used = {}
            v.settlers.forEach(s => { if (s.voice && !s.dead) used[s.voice] = (used[s.voice] || 0) + 1 })
            var best = pool[0]
            pool.forEach(p => { if ((used[p] || 0) < (used[best] || 0)) best = p })
            var least = pool.filter(p => (used[p] || 0) === (used[best] || 0))
            rec.voice = least[Math.floor(Math.random() * least.length)]
            seSave()
        }
        e.persistentData.putString("tfg_voice_id", rec.voice)
    } catch (err) { }
}

function seTraderSetup(e) {
    try {
        var vid = seTagValue(e, "tfg_v_"), sid = seTagValue(e, "tfg_sid_")
        var v = vid && seLoad().villages[vid]
        var rec = v && v.settlers.filter(x => x.id === sid)[0]
        if (!rec) return
        if (!rec.trade) { rec.trade = seTradeKind(); seSave() }
        var pd = e.persistentData
        pd.putString("tfg_trader_kind", rec.trade)
        pd.putString("tfg_trader_faction", String(v.faction || "ash"))
        pd.putInt("tfg_trader_tier", SE_TRADE_TIER)
        if (typeof trOffers === "function") {
            // у сельского торговца специализация закреплена за его койкой в поселении
            var seed = v.id + ":" + rec.id
            var offers = trOffers(rec.trade, SE_TRADE_TIER, seed)
            pd.putString("tfg_trader_seed", seed)
            if (offers.spec) pd.putString("tfg_trader_spec", offers.spec)
            pd.putString("tfg_trader_offers", JSON.stringify(offers))
        }
        e.addTag("tfg_trader")
        seRestoreSettlerName(e)                       // подпись с ремеслом - и у тех, кто вышел раньше
    } catch (err) { seErr("торговец", err) }
}

// ─── Поиск своих в мире ──────────────────────────────────────────────────────

function seEntities(level, village) {
    var out = []
    try {
        var list = level.getEntities()
        for (var i = 0; i < list.size(); i++) {
            var e = list.get(i)
            if (!e || !e.getTags) continue
            if (!e.getTags().contains("tfg_v_" + village.id)) continue
            out.push(e)
        }
    } catch (e) { seErr("поиск жителей", e) }
    return out
}

// роль в метке: латиницей, чтобы селектор не спотыкался о кириллицу
const SE_ROLE_TAG = {
    "правитель": "ruler", "крестьянин": "farmer", "охотник": "hunter", "лесоруб": "logger",
    "рыцарь": "knight", "стрелок": "shooter", "дружинник": "militia", "бард": "bard", "торговец": "trader",
}
const SE_TAG_ROLE = {}
for (var seRK in SE_ROLE_TAG) SE_TAG_ROLE[SE_ROLE_TAG[seRK]] = seRK
function seRoleTag(role) { return SE_ROLE_TAG[role] || "farmer" }

function seTagValue(e, prefix) {
    try {
        var it = e.getTags().iterator()
        while (it.hasNext()) {
            var t = String(it.next())
            if (t.indexOf(prefix) === 0) return t.substring(prefix.length)
        }
    } catch (err) { }
    return null
}

function seRoleOf(e) { return SE_TAG_ROLE[seTagValue(e, "tfg_role_")] || "крестьянин" }
function seSidOf(e) { return seTagValue(e, "tfg_sid_") }

// ─── Дороги: граф вех и поиск пути ───────────────────────────────────────────
//
// Встроенная навигация мобов ищет путь по клеткам вокруг себя и в доме упирается в
// лестницу, дверь или угол - отсюда и толпа болванчиков по углам. Поэтому поверх неё
// кладём свой слой: сеть троп поселения превращается в граф вех, путь между вехами
// ищется A*, а навигации остаётся короткий отрезок от вехи до вехи.

const SE_NODE_STEP = 3               // через сколько блоков ставим веху на тропе
const SE_LINK = 5                    // на таком расстоянии вехи считаются соседними
const SE_CLIMB = 2                   // и на такой перепад высоты

/** Собрать граф вех по уложенным тропам. Делается один раз и хранится вместе с поселением. */
function seBuildGraph(level, v) {

    var nodes = []

    var street = null

    try { street = global.TFG_STREET.list()[v.settlement] } catch (e) { }

    var cells = street && street.paths ? street.paths : null

    if (cells && cells.length) {

        // клетки троп сохранены при постройке - берём их, это и точнее, и дешевле

        cells.forEach(c => {

            var y = 70

            try { y = Number(level.getHeight("WORLD_SURFACE_WG", c[0], c[1])) - 1 } catch (e) { }

            nodes.push([c[0], y, c[1]])

        })

    } else {

        // старое поселение без записи троп: ищем дёрн в мире

        var seen = {}

        var r = (v.ring || 28) + 110

        for (var x = v.x - r; x <= v.x + r; x += 2) {

            for (var z = v.z - r; z <= v.z + r; z += 2) {

                var y2 = 0

                try { y2 = Number(level.getHeight("WORLD_SURFACE_WG", x, z)) - 1 } catch (e) { continue }

                var id = ""

                try { id = String(level.getBlock(x, y2, z).id) } catch (e) { continue }

                if (id.indexOf("grass_path") < 0) continue

                var k = x + "," + z

                if (seen[k]) continue

                seen[k] = 1

                nodes.push([x, y2, z])

            }

        }

    }

    // Прореживаем: вехи чаще чем через три блока не нужны, а перебор пар растёт квадратом.
    var thin = [], grid = {}
    nodes.forEach(n => {
        var k = Math.floor(n[0] / SE_NODE_STEP) + "," + Math.floor(n[2] / SE_NODE_STEP)
        if (grid[k] !== undefined) return
        grid[k] = 1
        thin.push(n)
    })
    nodes = thin

    // Связи ищем по ячейкам сетки, а не перебором всех пар: на паре тысяч вех это
    // миллионы сравнений при каждом построении.
    var buckets = {}
    nodes.forEach((n, i) => {
        var k = Math.floor(n[0] / SE_LINK) + "," + Math.floor(n[2] / SE_LINK)
        if (!buckets[k]) buckets[k] = []
        buckets[k].push(i)
    })
    var links = []
    for (var i = 0; i < nodes.length; i++) {
        var near = []
        var bx = Math.floor(nodes[i][0] / SE_LINK), bz = Math.floor(nodes[i][2] / SE_LINK)
        for (var ox = -1; ox <= 1; ox++) {
            for (var oz = -1; oz <= 1; oz++) {
                var list = buckets[(bx + ox) + "," + (bz + oz)]
                if (!list) continue
                for (var li = 0; li < list.length; li++) {
                    var j = list[li]
                    if (i === j) continue
                    var dx = nodes[i][0] - nodes[j][0], dz = nodes[i][2] - nodes[j][2]
                    if (Math.abs(dx) > SE_LINK || Math.abs(dz) > SE_LINK) continue
                    if (Math.abs(nodes[i][1] - nodes[j][1]) > SE_CLIMB) continue
                    near.push(j)
                }
            }
        }
        links.push(near)
    }
    // Сшиваем куски: там, где мощение пропустило клетку под навесом, граф распадается.
    // Связываем каждый обрывок с главной сетью по ближайшей паре вех.
    var comp = new Array(nodes.length)
    var compN = 0
    for (var ci = 0; ci < nodes.length; ci++) {
        if (comp[ci] !== undefined) continue
        var stack = [ci]
        comp[ci] = compN
        while (stack.length) {
            var cur = stack.pop()
            var ls = links[cur] || []
            for (var li2 = 0; li2 < ls.length; li2++) {
                if (comp[ls[li2]] === undefined) { comp[ls[li2]] = compN; stack.push(ls[li2]) }
            }
        }
        compN++
    }
    if (compN > 1) {
        var sizes = []
        for (var si = 0; si < compN; si++) sizes.push(0)   // без Array.fill: Rhino на нём спотыкается
        comp.forEach(c => { sizes[c]++ })
        var main = 0
        for (var mi = 1; mi < compN; mi++) if (sizes[mi] > sizes[main]) main = mi
        var joined = 0
        for (var k = 0; k < compN; k++) {
            if (k === main) continue
            var bestA = -1, bestB = -1, bestD = 1e18
            for (var a = 0; a < nodes.length; a++) {
                if (comp[a] !== k) continue
                for (var b = 0; b < nodes.length; b++) {
                    if (comp[b] !== main) continue
                    var dx2 = nodes[a][0] - nodes[b][0], dz2 = nodes[a][2] - nodes[b][2]
                    var d2 = dx2 * dx2 + dz2 * dz2
                    if (d2 < bestD) { bestD = d2; bestA = a; bestB = b }
                }
            }
            if (bestA < 0 || bestD > 400) continue          // дальше двадцати блоков не сшиваем
            links[bestA].push(bestB)
            links[bestB].push(bestA)
            joined++
        }
        if (joined) seLog("поселение " + v.id + ": сшито обрывков сети " + joined)
    }

    v.graph = { nodes: nodes, links: links }

    seSave()

    seLog("поселение " + v.id + ": вех на тропах " + nodes.length)

    return v.graph

}



function seNearestNode(v, x, z) {
    if (!v.graph || !v.graph.nodes.length) return -1
    var best = -1, bestD = 1e18
    var n = v.graph.nodes
    for (var i = 0; i < n.length; i++) {
        var dx = n[i][0] - x, dz = n[i][2] - z
        var d = dx * dx + dz * dz
        if (d < bestD) { bestD = d; best = i }
    }
    return bestD < 40 * 40 ? best : -1              // слишком далеко от троп - идти напрямую
}

/** Поиск пути по вехам: обычный A* с евклидовой оценкой. */
function seRoute(v, from, to) {
    if (!v.graph || from < 0 || to < 0) return null
    if (from === to) return [to]
    var nodes = v.graph.nodes, links = v.graph.links
    var dist = {}, prev = {}, open = [from]
    var score = {}
    dist[from] = 0
    score[from] = 0
    var guard = 0
    while (open.length && guard++ < 20000) {
        // берём самую перспективную веху
        var bi = 0
        for (var i = 1; i < open.length; i++) if (score[open[i]] < score[open[bi]]) bi = i
        var cur = open.splice(bi, 1)[0]
        if (cur === to) break
        var ls = links[cur] || []
        for (var li = 0; li < ls.length; li++) {
            var nx = ls[li]
            var a = nodes[cur], b = nodes[nx]
            var step = Math.sqrt(Math.pow(a[0] - b[0], 2) + Math.pow(a[2] - b[2], 2)) + Math.abs(a[1] - b[1])
            var nd = dist[cur] + step
            if (dist[nx] !== undefined && dist[nx] <= nd) continue
            dist[nx] = nd
            prev[nx] = cur
            var t = nodes[to]
            score[nx] = nd + Math.sqrt(Math.pow(b[0] - t[0], 2) + Math.pow(b[2] - t[2], 2))
            if (open.indexOf(nx) < 0) open.push(nx)
        }
    }
    if (dist[to] === undefined) return null
    var path = [to]
    var c = to
    while (prev[c] !== undefined) { c = prev[c]; path.push(c) }
    path.reverse()
    return path
}

var SE_ROUTE = {}                    // uuid -> { path, i, at, gx, gz }
var SE_MOVE = {}                     // uuid -> { gx, gz, speed, px, pz, pt, fails, detour }
var SE_DOORS = {}                    // "x,y,z" -> { dim, state, at } - что открыли и когда

const SE_RUN = 1.55                  // с этой доли скорости житель переходит на бег
const SE_DOOR_CLOSE = 200            // через столько тиков дверь закрывается сама

/**
 * Шаг движения. Здесь всё, что касается ног: бег, открытые двери и память о цели.
 * Скорость - множитель к скорости ходьбы; от SE_RUN и выше это уже бег.
 */
function seMove(e, x, y, z, speed) {
    var u = String(e.uuid)
    var m = SE_MOVE[u] || (SE_MOVE[u] = { fails: 0 })
    var now = Number(e.level.getTime())
    if (m.gx === undefined || Math.pow(m.gx - x, 2) + Math.pow(m.gz - z, 2) > 9) { m.fails = 0; m.detour = null }
    m.gx = x
    m.gy = y
    m.gz = z
    m.speed = speed
    m.at = now
    try { e.setSprinting(speed >= SE_RUN) } catch (err) { }
    seOpenDoors(e)
    if (m.detour && now < m.detour.until) {
        e.getNavigation().moveTo(m.detour.x, m.detour.y, m.detour.z, speed)
        return
    }
    m.detour = null
    e.getNavigation().moveTo(x, y, z, speed)
}

/**
 * Открыть дверь перед носом. Навигация хаска дверей не открывает, поэтому жители
 * запирались в домах - ровно то, на что жаловались. Створку выставляем открытой
 * командой, вторая половина двери подхватывает состояние сама.
 */
function seOpenDoors(e, radius) {
    var level = e.level
    var r = radius || 1
    var bx = Math.floor(e.getX()), by = Math.floor(e.getY()), bz = Math.floor(e.getZ())
    for (var dx = -r; dx <= r; dx++) {
        for (var dz = -r; dz <= r; dz++) {
            for (var dy = r > 1 ? -2 : 0; dy <= (r > 1 ? 3 : 1); dy++) {
                var x = bx + dx, y = by + dy, z = bz + dz
                var st = ""
                try { st = String(level.getBlock(x, y, z).getBlockState()) } catch (err) { continue }
                if (st.indexOf("open=false") < 0) continue
                if (st.indexOf("_door") < 0 && st.indexOf("fence_gate") < 0) continue
                var full = seStateString(st)
                if (!full) continue
                var key = x + "," + y + "," + z
                if (SE_DOORS[key]) continue
                SE_DOORS[key] = { dim: String(level.getDimension()), state: full, at: Number(level.getTime()) }
                seRun("execute in " + String(level.getDimension()) + " run setblock " + x + " " + y + " " + z + " " +
                    full.replace("open=false", "open=true") + " replace")
            }
        }
    }
}

/** "Block{minecraft:oak_door}[facing=north,open=false]" -> "minecraft:oak_door[facing=north,open=false]" */
function seStateString(st) {
    var m = String(st).match(/^Block\{([^}]+)\}(\[.*\])?$/)
    if (!m) return null
    return m[1] + (m[2] || "")
}

/** Закрыть за собой: дверь стоит открытой недолго, если рядом никого нет. */
function seDoorsTick(level) {
    var now = Number(level.getTime())
    for (var key in SE_DOORS) {
        var d = SE_DOORS[key]
        if (now - d.at < SE_DOOR_CLOSE) continue
        var p = key.split(",")
        delete SE_DOORS[key]
        seRun("execute in " + d.dim + " run setblock " + p[0] + " " + p[1] + " " + p[2] + " " + d.state + " replace")
    }
}

/**
 * Лестница. Навигация мобов вертикальные лестницы почти не выбирает: житель топчется
 * под ней или рядом с проёмом. Поэтому, если цель заметно выше или ниже, ищем лестницу
 * вплотную и переставляем жителя по ней на блок за раз - со стороны это и есть подъём.
 * Возвращает true, если лезем.
 */
function seClimb(level, v, e) {
    var u = String(e.uuid)
    var m = SE_MOVE[u]
    if (!m || m.gy === undefined) return false
    var now = Number(level.getTime())
    if (now < (m.climbAt || 0)) return true                 // шаг уже сделан, ждём следующего
    var by = Math.floor(e.getY())
    var dir = m.gy > by + 2 ? 1 : (m.gy < by - 2 ? -1 : 0)
    if (!dir) return false
    var bx = Math.floor(e.getX()), bz = Math.floor(e.getZ())
    for (var dx = -2; dx <= 2; dx++) {
        for (var dz = -2; dz <= 2; dz++) {
            for (var dy = -1; dy <= 2; dy++) {
                var id = ""
                try { id = String(level.getBlock(bx + dx, by + dy, bz + dz).id) } catch (err) { continue }
                if (id.indexOf("ladder") < 0) continue
                var lx = bx + dx, lz = bz + dz
                var ny = by + dir
                var atNew = ""
                try { atNew = String(level.getBlock(lx, ny, lz).id) } catch (err) { continue }
                // лезем, пока над головой лестница; дошли до верха - выходим на площадку
                if (atNew.indexOf("ladder") < 0 && dir > 0) {
                    var free = seOpenAt(level, lx, ny, lz) && seOpenAt(level, lx, ny + 1, lz)
                    if (!free) continue
                }
                seRun("execute in " + v.dim + " run tp " + u + " " + (lx + 0.5) + " " + ny + " " + (lz + 0.5))
                m.climbAt = now + 8
                return true
            }
        }
    }
    return false
}

/**
 * Высокий прыжок. Поиск пути не видит дороги - уступ выше обычного прыжка (край шахты,
 * подпорная стенка): житель прыгает на два блока, а если и так не выйдет - на три.
 * Смотрим клетку впереди по направлению к цели: встать там можно на высоте h, а над
 * головой до этой высоты пусто. h = 1 берёт обычный прыжок; выше трёх - не прыгнуть.
 */
function seLeap(e, m) {
    var ground = true
    try { ground = typeof e.onGround === "function" ? e.onGround() : e.isOnGround() } catch (err) { }
    if (!ground) return false
    var level = e.level
    var gx = m.gx - e.getX(), gz = m.gz - e.getZ(), d = Math.sqrt(gx * gx + gz * gz) || 1
    var ex = Math.floor(e.getX()), ez = Math.floor(e.getZ()), y = Math.floor(e.getY())
    var fx = Math.floor(e.getX() + gx / d), fz = Math.floor(e.getZ() + gz / d)
    if (fx === ex && fz === ez) return false
    for (var h = 1; h <= 3; h++) {
        if (!seOpenAt(level, ex, y + h + 1, ez)) return false          // потолок над головой
        if (!seStandable(level, fx, y + h, fz)) continue
        if (h === 1) return false                                       // хватит обычного прыжка
        e.setMotion(gx / d * 0.25, h === 2 ? 0.62 : 0.76, gz / d * 0.25)
        return true
    }
    return false
}

/**
 * Житель идёт, но не двигается - значит уткнулся в косяк, забор или угол комнаты.
 * Сперва прыжок и обход сбоку, а после нескольких неудач вытаскиваем его к ближайшей
 * вехе тропы: иначе он так и простоит в доме до утра (проверено на гостях).
 */
function seStuck(e, v) {
    var u = String(e.uuid)
    var m = SE_MOVE[u]
    if (!m || m.gx === undefined) return
    var now = Number(e.level.getTime())
    if (now - (m.at || 0) > 100) return                   // идти уже не велено
    var dx = e.getX() - m.gx, dz = e.getZ() - m.gz
    if (dx * dx + dz * dz < 6.25) { m.fails = 0; m.outs = 0; return }
    if (!m.pt || now - m.pt >= 40) {
        var moved = m.pt ? Math.pow(e.getX() - m.px, 2) + Math.pow(e.getZ() - m.pz, 2) : 99
        m.px = e.getX()
        m.pz = e.getZ()
        m.pt = now
        if (moved > 0.6) { m.fails = 0; return }
        try { if (seClimb(e.level, v, e)) { m.fails = 0; return } } catch (err) { }
        try { if (seLeap(e, m)) { m.fails = 0; return } } catch (err) { }
        try { e.getJumpControl().jump() } catch (err) { }
        m.fails++
        if (m.fails === 1) { try { seOpenDoors(e, 5) } catch (err) { } }   // заперт в доме - отпираем весь дом
        if (m.fails >= 5) {
            m.fails = 0
            m.detour = null
            m.outs = (m.outs || 0) + 1
            try { e.getNavigation().stop() } catch (err) { }
            // второй раз подряд никуда не дошёл - заперт: переносим на тропу
            if (m.outs >= 2) {
                m.outs = 0
                // Куда вытаскивать: к своей койке (точные три числа), к форту или
                // просто на ближайшую тропу. Высоту у построек брать нельзя - это крыша.
                var tp = null
                if (m.rescue && m.rescue.y !== undefined) {
                    tp = [m.rescue.x + 0.5, m.rescue.y, m.rescue.z + 0.5]
                } else {
                    var ax = m.rescue ? m.rescue.x : e.getX(), az = m.rescue ? m.rescue.z : e.getZ()
                    var n = seNearestNode(v, ax, az)
                    var node = v.graph && v.graph.nodes && n >= 0 ? v.graph.nodes[n] : null
                    if (node) tp = [node[0] + 0.5, node[1] + 1, node[2] + 0.5]
                }
                if (tp) {
                    seRun("execute in " + v.dim + " run tp " + String(e.uuid) + " " +
                        tp[0] + " " + tp[1] + " " + tp[2])
                    seLog("вытащил застрявшего " + u.substring(0, 8))
                }
                return
            }
            return
        }
        // обход: вбок от направления на цель, сторона чередуется
        var gx = m.gx - e.getX(), gz = m.gz - e.getZ(), d = Math.sqrt(gx * gx + gz * gz) || 1
        var side = m.fails % 2 === 0 ? 1 : -1
        var off = 3 + m.fails * 1.5
        var px = e.getX() - gz / d * off * side
        var pz = e.getZ() + gx / d * off * side
        var py = e.getY()
        try { py = Number(e.level.getHeight("WORLD_SURFACE_WG", Math.floor(px), Math.floor(pz))) } catch (err) { }
        m.detour = { x: px, y: py, z: pz, until: now + 100 }
        try { e.getNavigation().moveTo(px, py, pz, m.speed || 1) } catch (err) { }
    }
}

/**
 * Выход из дома при нападении. Житель на верхнем этаже или застрявший в доме по лестницам
 * и коридорам не выбирается, а бежать ему надо сейчас. Поэтому переносим его за порог его
 * постройки - только так, чтобы никто из игроков этого не видел: рядом никого нет, а кто
 * дальше - не смотрит на него прямой видимостью. Форт и башню не трогаем: туда и бегут.
 */
var SE_EVAC = {}                     // uuid -> когда переносили в последний раз
const SE_EVAC_EVERY = 200            // не чаще раза в десять секунд
const SE_EVAC_SEEN_R = 48            // дальше этого игрок его уже не разглядит

function seSeenByPlayer(level, e) {
    var seen = false
    try {
        level.getServer().players.forEach(p => {
            if (seen || String(p.level.getDimension()) !== String(level.getDimension())) return
            var dx = p.getX() - e.getX(), dy = p.getY() - e.getY(), dz = p.getZ() - e.getZ()
            var d2 = dx * dx + dy * dy + dz * dz
            if (d2 > SE_EVAC_SEEN_R * SE_EVAC_SEEN_R) return
            if (d2 < 8 * 8) { seen = true; return }             // вплотную - заметит в любом случае
            var los = true
            try {
                if (typeof p.hasLineOfSight === "function") los = !!p.hasLineOfSight(e)
                else if (typeof p.m_142582_ === "function") los = !!p.m_142582_(e)
            } catch (err) { los = true }
            if (los) seen = true
        })
    } catch (err) { return true }
    return seen
}

/** Постройка улицы (не форт и не башня), внутри которой стоит житель. */
function seBuildingAt(v, x, z, level, y) {
    var st = seStreet(v)
    if (!st) return null
    var bx = Math.floor(x), bz = Math.floor(z)
    // В крепости - это крепость, а не соседний дом: коробки домов в тесной застройке налезают
    // на её двор, и житель во дворе считался «застрявшим в доме» - его уносило к чужой двери
    // за стену, он шёл обратно к воротам, и так по кругу.
    var fs = seFortSpot(v)
    if (fs && fs.box && bx >= fs.box.x1 && bx <= fs.box.x2 && bz >= fs.box.z1 && bz <= fs.box.z2) return null
    // в доме - значит под крышей: на открытой земле у дома никто не «застревает»
    if (level && y !== undefined) {
        var roofed = false
        for (var up = 2; up <= 8 && !roofed; up++) {
            var rid = ""
            try { rid = String(level.getBlock(bx, Math.floor(y) + up, bz).id) } catch (err) { break }
            if (rid !== "minecraft:air" && rid.indexOf("leaves") < 0) roofed = true
        }
        if (!roofed) return null
    }
    var list = st.buildings || []
    for (var i = 0; i < list.length; i++) {
        var b = list[i]
        if (!b.door || b.type === "форт" || b.type === "башня") continue
        if (bx < b.x || bx >= b.x + b.size[0] || bz < b.z || bz >= b.z + b.size[2]) continue
        var core = null
        try { core = global.TFG_STRUCTURES.core(b.zone) } catch (err) { }
        if (core && !core.cols[bx + "," + bz]) continue     // коробки соседей налезают - берём того, чьи стены
        return b
    }
    return null
}

function seEvac(level, v, e) {
    if (v.state !== "тревога" && v.state !== "осада" && v.state !== "вылазка") return
    var u = String(e.uuid), now = Number(level.getTime())
    if (now - (SE_EVAC[u] || -1e9) < SE_EVAC_EVERY) return
    var b = seBuildingAt(v, e.getX(), e.getZ(), level, e.getY())
    if (!b) return
    var high = e.getY() >= b.door.y + 3                    // этажом выше входа
    var m = SE_MOVE[u]
    var stuck = !!(m && m.fails >= 2)                      // секунды три не может сдвинуться
    if (!high && !stuck) return
    if (seSeenByPlayer(level, e)) return
    var o = b.door.out || { dx: 0, dz: 1 }
    var px = Math.round(b.door.x + (o.dx || 0) * 2), pz = Math.round(b.door.z + (o.dz || 0) * 2)
    var py = null
    ;[0, 1, -1, 2, -2].forEach(dy => { if (py === null && seStandable(level, px, Math.round(b.door.y) + dy, pz)) py = Math.round(b.door.y) + dy })
    if (py === null) return
    SE_EVAC[u] = now
    seRun("execute in " + v.dim + " run tp " + u + " " + (px + 0.5) + " " + py + " " + (pz + 0.5))
    if (m) { m.fails = 0; m.outs = 0; m.detour = null }
    SE_ROUTE[u] = null
    try { e.getNavigation().stop() } catch (err) { }
}

/**
 * Идти к точке по тропам. Пока веха рядом - шагаем к следующей; если жителя сносит
 * с маршрута или он встал, маршрут строится заново.
 */
/** fixY - высота цели, если она известна (ворота, двор): иначе берётся верх столба, а это бывает крыша. */
function seGo(e, v, tx, tz, speed, fixY) {
    var u = String(e.uuid)
    var now = Number(e.level.getTime())
    var dx = e.getX() - tx, dz = e.getZ() - tz
    // Далеко за поселением (лесоруб и охотник уходят за целью) троп нет, а навигация не
    // строит путь дальше ~48 блоков: идём перебежками по 32 блока прямо к цели.
    var ox = e.getX() - v.x, oz = e.getZ() - v.z, outer = (v.ring || 28) + 70
    if (dx * dx + dz * dz > 48 * 48 && ox * ox + oz * oz > outer * outer) {
        var dd = Math.sqrt(dx * dx + dz * dz)
        var lx = e.getX() - dx / dd * 32, lz = e.getZ() - dz / dd * 32
        var ly = e.getY()
        try { ly = Number(e.level.getHeight("MOTION_BLOCKING_NO_LEAVES", Math.floor(lx), Math.floor(lz))) } catch (err) { }
        seMove(e, lx, ly, lz, speed)
        SE_ROUTE[u] = null
        return
    }
    if (dx * dx + dz * dz < 36) {                    // почти пришли - дальше сам
        var ty = e.getY()
        if (fixY !== undefined && fixY !== null) ty = fixY
        else try { ty = Number(e.level.getHeight("WORLD_SURFACE_WG", Math.floor(tx), Math.floor(tz))) } catch (err) { }
        seMove(e, tx, ty, tz, speed)
        SE_ROUTE[u] = null
        return
    }
    var st = SE_ROUTE[u]
    var stale = !st || st.gx !== Math.round(tx) || st.gz !== Math.round(tz) || now - st.at > 600
    if (stale) {
        var a = seNearestNode(v, e.getX(), e.getZ())
        var b = seNearestNode(v, tx, tz)
        var path = seRoute(v, a, b)
        st = SE_ROUTE[u] = { path: path, i: 0, at: now, gx: Math.round(tx), gz: Math.round(tz) }
    }
    if (!st.path || !st.path.length) {               // троп рядом нет - идём напрямую
        var y2 = e.getY()
        if (fixY !== undefined && fixY !== null) y2 = fixY
        else try { y2 = Number(e.level.getHeight("WORLD_SURFACE_WG", Math.floor(tx), Math.floor(tz))) } catch (err) { }
        seMove(e, tx, y2, tz, speed)
        return
    }
    var node = v.graph.nodes[st.path[st.i]]
    var ndx = e.getX() - node[0], ndz = e.getZ() - node[2]
    if (ndx * ndx + ndz * ndz < 9) {                 // веха достигнута
        st.i++
        st.at = now
        if (st.i >= st.path.length) {
            // Вехи кончились, а цель ещё не под ногами: дальше своим ходом. Раньше здесь
            // был просто выход - и житель, у которого маршрут выродился в одну веху,
            // стоял столбом до скончания века.
            SE_ROUTE[u] = null
            var y3 = e.getY()
            if (fixY !== undefined && fixY !== null) y3 = fixY
        else try { y3 = Number(e.level.getHeight("WORLD_SURFACE_WG", Math.floor(tx), Math.floor(tz))) } catch (err) { }
            seMove(e, tx, y3, tz, speed)
            return
        }
        node = v.graph.nodes[st.path[st.i]]
    }
    seMove(e, node[0] + 0.5, node[1] + 1, node[2] + 0.5, speed)
}

// ─── Распорядок дня ──────────────────────────────────────────────────────────

function seIsNight(level) {
    var t = Number(level.getDayTime()) % SE_DAY
    return t >= SE_NIGHT_FROM && t <= SE_NIGHT_TO
}

/**
 * Чем житель занят прямо сейчас. Решение принимается по роли, времени суток и
 * состоянию поселения - а не по месту, где он оказался.
 */
function seDuty(village, role, sid, night, shift) {
    // Первые полторы минуты после заселения все расходятся по делам, даже ночью:
    // иначе сразу после /tfgvillage spawn поселение выглядит вымершим, что и было.
    if (village.spawnedAt && Number(SE_SERVER.overworld().getTime()) - village.spawnedAt < 1800 &&
        village.state === "мир") return "разойтись"
    if (village.state === "тревога") return role === "правитель" ? "трубить" : "в форт"
    if (village.state === "осада") {
        if (role === "рыцарь" || role === "дружинник") return "ворота"
        if (role === "стрелок") return "стена"
        if (role === "правитель") return "трубить"
        return "прятаться"
    }
    if (village.state === "вылазка") {
        if (role === "рыцарь" || role === "стрелок" || role === "дружинник") return "вылазка"
        return "прятаться"
    }
    if (village.state === "сдалось") return "сдаться"

    if (shift === undefined) shift = Number(String(sid || "n0").replace(/[^0-9]/g, "")) % 2 === 0
    // вечер: мирные бросают дела и собираются послушать барда, если он в поселении есть
    if (!night && SE_LISTENERS.indexOf(role) >= 0 &&
        Number(SE_SERVER.overworld().getDayTime()) % SE_DAY >= SE_EVENING_FROM &&
        village.settlers.some(s => s.role === "бард" && !s.dead && !s.replaced)) return "слушать"
    switch (role) {
        case "рыцарь":
        case "стрелок":
            // Стража спит посменно: половина ночью, половина днём. Бодрствующие поровну
            // делят время между дозором по поселению и службой в форте.
            if (night === shift) return "спать"
            var half = Math.floor(Number(SE_SERVER.overworld().getTime()) / 2400) % 2 === 0
            return half ? "дозор" : "форт"
        case "правитель":
            return night ? "спать" : "обход"
        case "охотник":
            return night ? "спать" : "охота"
        case "лесоруб":
            return night ? "спать" : "лес"
        case "бард":
            // играет только вечером, на улице, для собравшихся; днём живёт как все
            if (night) return "спать"
            return Number(SE_SERVER.overworld().getDayTime()) % SE_DAY >= SE_EVENING_FROM ? "играть" : "бард днём"
        case "торговец":
            return night ? "спать" : "лавка"
        case "дружинник":
            return night ? "спать" : "двор"
        default:
            return night ? "спать" : "работа"
    }
}

// ─── Угроза и нападение игрока ───────────────────────────────────────────────

/** Отметить враждебное действие игрока. Возвращает true, если поселение объявило его врагом. */
var SE_HURT_TOLD = 0

const SE_HOSTILE_FORGET = 12000      // враждебность игрока забывается через 10 минут без новых нападений

function seNoteHostile(village, playerUuid, kind, amount) {
    // в бою с налётчиками по своим попадают случайно - это не делает игрока врагом
    if (kind === "удар") { try { if (typeof sgActiveFor === "function" && sgActiveFor(village.id)) return false } catch (e) { } }
    if (!village.threat) village.threat = {}
    var t = village.threat[playerUuid] || (village.threat[playerUuid] = { hits: 0, damage: 0, blocks: 0, stolen: 0, hostile: false })
    t.at = Number(SE_SERVER.overworld().getTime())
    if (kind === "удар") { t.hits++; t.damage += amount || 0 }
    if (kind === "блоки") t.blocks += amount || 0
    if (kind === "кража") t.stolen += amount || 0
    var was = t.hostile
    if (t.hits >= SE_HOSTILE_HITS) t.hostile = true
    if (kind === "удар" && amount && amount >= SE_HOSTILE_DAMAGE) t.hostile = true
    if (t.blocks >= SE_HOSTILE_VALUE || t.stolen >= SE_HOSTILE_VALUE) t.hostile = true
    if (t.hostile && !was) {
        seAlarm(village, "игрок")
        seLog("поселение " + village.id + ": игрок " + playerUuid + " объявлен врагом (" + kind + ")")
    }
    seSave()
    return t.hostile
}

function seAlarm(village, why) {
    if (village.state === "сдалось") return
    if (village.state === "мир") {
        village.state = "тревога"
        village.alarmAt = Number(SE_SERVER.overworld().getTime())
        seSay(village, "тревога", village.x, 80, village.z)
        // рог глашатая слышно далеко
        seRun("execute in " + village.dim + " positioned " + village.x + " 80 " + village.z +
            " run playsound minecraft:item.goat_horn.sound.0 hostile @a[distance=..160] ~ ~ ~ 3 0.8")
        seLog("поселение " + village.id + ": тревога (" + why + ")")
        seSave()
    }
}

/** Живая сила гарнизона: по ней считается и сила нападающего отряда. */
function seGarrison(village) {
    var n = 0
    village.settlers.forEach(s => {
        if (s.dead) return
        if (SE_ROLES[s.role] && SE_ROLES[s.role].garrison) n++
    })
    return n
}

// ─── Нападение на поселение ──────────────────────────────────────────────────

/** Налёт на поселение - настоящий рейд (tfg/raids.js) через осады. Возвращает текст ошибки или null. */
function seRaid(level, village, factionId) {
    if (!SE_SERVER) SE_SERVER = level.getServer()
    return global.TFG_SIEGES.start(SE_SERVER.overworld(), village, factionId || "bandits")
}

// ─── Сдача, бегство и захват ─────────────────────────────────────────────────

function seCheckSurrender(village) {
    // считаем только нынешних жителей: после смены хозяев в записи остаются прежние
    // (dead + replaced), и первым «правителем» оказывался павший прежний - новое
    // поселение сдавалось, едва появившись
    var now = village.settlers.filter(s => !s.replaced)
    var ruler = now.filter(s => s.role === "правитель" && !s.dead)[0] || now.filter(s => s.role === "правитель")[0]
    var garrison = seGarrison(village)
    var total = now.filter(s => SE_ROLES[s.role] && SE_ROLES[s.role].garrison).length
    var rulerDead = !ruler || ruler.dead
    if (!rulerDead || total === 0) return false
    if (garrison > total / 2) return false
    if (village.state === "сдалось") return true
    village.state = "сдалось"
    village.surrenderAt = Number(SE_SERVER.overworld().getTime())
    seSay(village, "сдача", village.x, 80, village.z)
    seLog("поселение " + village.id + " сдалось")
    seSave()
    return true
}

/** Разбежаться в лес и исчезнуть: поселение опустело. */
function seFlee(village) {
    var ents = seEntities(SE_SERVER.overworld(), village)
    ents.forEach(e => {
        try {
            var a = Math.random() * 6.283185307179586
            e.getNavigation().moveTo(village.x + Math.cos(a) * 120, e.getY(), village.z + Math.sin(a) * 120, 1.2)
        } catch (err) { }
    })
    village.fleeing = Number(SE_SERVER.overworld().getTime())
    seSave()
}

// ─── Присмотр: уборка, пополнение, смена хозяина ─────────────────────────────

/**
 * Раз в трое суток без игрока рядом: постройки возвращаются к исходному виду,
 * хранилища наполняются заново, вместо погибших приходят новые жители.
 * Старые при этом остаются - никто не воскресает.
 */
function seUpkeep(level, village, force) {
    var now = Number(level.getTime())
    if (!force) {
        if (now - (village.lastUpkeep || 0) < SE_UPKEEP_DAYS * SE_DAY) return false
        if (sePlayerNear(level, village, 128)) return false
    }
    village.lastUpkeep = now

    // пополняем состав до числа коек
    var alive = village.settlers.filter(s => !s.dead).length
    var need = (village.beds || village.settlers.length) - alive
    for (var i = 0; i < need; i++) {
        var role = SE_ROLE_ORDER[(village.settlers.length + i) % SE_ROLE_ORDER.length]
        var female = Math.random() < SE_FEMALE_SHARE
        var bed = village.settlers[(village.settlers.length + i) % Math.max(1, village.settlers.length)]
        village.settlers.push({
            id: "n" + (village.settlers.length + i), role: role, female: female, name: seName(role, female),
            bed: bed ? bed.bed : { x: village.x, y: 70, z: village.z }, home: "дом",
            uuid: null, state: "дома", hp: SE_ROLES[role].hp, newcomer: true,
        })
    }
    // Сдавшееся (разграбленное) поселение пустым не стоит: через пару суток туда приходят
    // новые хозяева, а постройки встают целыми с полными хранилищами (seRebuildTick).
    if (village.state === "сдалось" && now - (village.surrenderAt || 0) >= SE_RESETTLE_DAYS * SE_DAY) {
        seResettle(level, village)
        return true
    }
    if (village.state !== "сдалось") village.state = "мир"
    // лавки пополняются: за три дня без игрока товар успевает подвезти
    try {
        seEntities(level, village).forEach(e => {
            if (seRoleOf(e) !== "торговец" || typeof trOffers !== "function") return
            var kind = String(e.persistentData.getString("tfg_trader_kind")) || "blacksmith"
            var seed = String(e.persistentData.getString("tfg_trader_seed")) || String(e.uuid)
            e.persistentData.putString("tfg_trader_offers", JSON.stringify(trOffers(kind, SE_TRADE_TIER, seed)))
        })
    } catch (e) { }
    seSave()
    seLog("поселение " + village.id + ": присмотр, новых жителей " + need)
    return true
}

// ─── Заселение разграбленного и пересборка построек ──────────────────────────

const SE_RESETTLE_DAYS = 2           // через столько суток после сдачи приходят новые хозяева
const SE_REBUILD_QUIET = 40          // ближе этого к середине игрок есть - пересборку откладываем
const SE_RESETTLE_NEAR = 64          // ближе этого к середине игрок есть - новые хозяева подождут

/** Кто займёт опустевшее место: чаще чужие, реже вернувшиеся хозяева; разбойники не селятся. */
function seResettleFaction(old) {
    var pool = []
    try { pool = global.TFG_FACTIONS.list.filter(f => f.id !== "bandits").map(f => f.id) } catch (e) { }
    if (!pool.length) return old
    var others = pool.filter(id => id !== old)
    return sePick(others.length && Math.random() < 0.7 ? others : pool)
}

/**
 * Новые хозяева: прежние уходят, на все койки приходят новые жители (sgChangeOwner в
 * factions/sieges.js - тот же путь, что при захвате поселения другой фракцией), сила
 * поселения сбрасывается к расчётной. Постройки пересобираются в seRebuildTick.
 */
function seResettle(level, village, faction) {
    var by = faction || seResettleFaction(village.faction)
    try {
        if (typeof sgChangeOwner === "function") sgChangeOwner(level, village, by)
        else village.faction = by
    } catch (e) { seErr("смена хозяина", e); village.faction = by }
    village.state = "мир"
    village.surrenderAt = 0
    village.threat = {}
    village.rebuildPending = true
    village.lastUpkeep = Number(level.getTime())
    seSave()
    seLog("поселение " + village.id + ": заселилась фракция " + by + ", постройки ждут пересборки")
    return by
}

/** Прогружено ли поселение целиком (середина и края кольца построек). */
function seLoadedAround(level, v) {
    var pts = [[0, 0], [80, 0], [-80, 0], [0, 80], [0, -80]]
    for (var i = 0; i < pts.length; i++) {
        try {
            if (!level.hasChunk(Math.floor(v.x + pts[i][0]) >> 4, Math.floor(v.z + pts[i][1]) >> 4)) return false
        } catch (e) { return false }
    }
    return true
}

/** Пересобрать постройки, когда поселение прогружено и рядом никто не стоит. */
function seRebuildTick(level, v, force) {
    if (!v.rebuildPending && !force) return false
    if (!force && (!seLoadedAround(level, v) || sePlayerNear(level, v, SE_REBUILD_QUIET))) return false
    var n = 0
    try { n = global.TFG_STREET.rebuild(level, v.settlement) } catch (e) { seErr("пересборка", e); return false }
    v.rebuildPending = false
    v.yard = null                                      // двор выглажен заново - места поставим снова
    seSave()
    seLog("поселение " + v.id + ": пересобрано построек " + n)
    return n
}

/**
 * Старый бак промзоны (короб 4x4x4, GregTech его не признавал) в уже построенных поселениях:
 * один раз ищем его вокруг поселения, пока рядом игрок, и ставим на его место правильный
 * многоблок 3x3x3 (decor.js, dcTank). Новые поселения строятся сразу с правильным.
 */
var SE_TANKFIX = {}                  // id поселения -> { i, miss, at }
const SE_TANK_R = 170                // промзона стоит за кольцом, до ~130 блоков от середины
const SE_TANK_PER_TICK = 400

function seTankFixTick(level, v) {
    if (v.tankFixed || !v.dim || v.dim !== String(level.getDimension())) return
    var now = Number(level.getTime())
    var st = SE_TANKFIX[v.id]
    if (st && st.wait && now < st.wait) return
    if (!sePlayerNear(level, v, 160)) return
    if (!st || st.wait) st = SE_TANKFIX[v.id] = { i: 0, miss: 0, wait: 0 }
    var side = SE_TANK_R + 1
    var x0 = Math.floor(v.x) - SE_TANK_R, z0 = Math.floor(v.z) - SE_TANK_R
    var id = (x, y, z) => { try { return String(level.getBlock(x, y, z).id) } catch (e) { return "" } }
    var n = 0
    while (st.i < side * side && n < SE_TANK_PER_TICK) {
        var x = x0 + (st.i % side) * 2, z = z0 + Math.floor(st.i / side) * 2
        st.i++
        n++
        try { if (!level.hasChunk(x >> 4, z >> 4)) { st.miss++; continue } } catch (e) { st.miss++; continue }
        var y = 0
        try { y = Number(level.getHeight("MOTION_BLOCKING", x, z)) - 1 } catch (e) { continue }
        if (id(x, y, z) !== "gtceu:bronze_brick_casing") continue
        // крыша бака найдена: контроллер где-то рядом, на 1-3 блока ниже
        for (var dx = -4; dx <= 4; dx++) for (var dz = -4; dz <= 4; dz++) for (var dy = -3; dy <= 0; dy++) {
            var cx = x + dx, cy = y + dy, cz = z + dz
            if (id(cx, cy, cz) !== "gtceu:bronze_multiblock_tank") continue
            var tx0 = cx - 1, tz0 = cz, base = cy - 4
            // у старого короба есть дальний угол на tz0+3, у правильного его нет
            if (id(tx0 + 3, base + 3, tz0 + 3) === "gtceu:bronze_brick_casing" &&
                id(tx0, base + 3, tz0 + 3) === "gtceu:bronze_brick_casing") {
                var post = id(tx0, base + 1, tz0)
                if (post.indexOf("fence") < 0) post = "tfc:wood/planks/oak_fence"
                var cmds = ["execute in " + v.dim + " run fill " + tx0 + " " + (base + 1) + " " + tz0 + " " +
                    (tx0 + 3) + " " + (base + 6) + " " + (tz0 + 3) + " minecraft:air replace"]
                global.TFG_DECOR.tank(cmds, v.dim, tx0, tz0, base, post)
                cmds.forEach(c => seRun(c))
                seLog("поселение " + v.id + ": старый бак " + tx0 + " " + (base + 3) + " " + tz0 + " заменён на многоблок 3x3x3")
            }
            v.tankFixed = true
            seSave()
            delete SE_TANKFIX[v.id]
            return
        }
    }
    if (st.i < side * side) return
    if (!st.miss) { v.tankFixed = true; seSave(); delete SE_TANKFIX[v.id]; return }   // бака нет вовсе
    st.wait = now + 6000             // часть округи не прогружена - пройдём ещё раз позже
}

/**
 * Показ ремесла. Житель на SE_FORCE_TICKS занят делом своей роли в любое время суток:
 * крестьянин на грядках, лесоруб в лесу, охотник гонит зверя, торговец у лавки, бард
 * играет на своём месте даже без слушателей. Мирный распорядок (сон, вечер у барда) на это
 * время отступает; тревога - нет.
 */
var SE_FORCE = {}                    // uuid -> до какого тика занят ремеслом
const SE_FORCE_TICKS = 12000         // десять минут
const SE_WORK_DUTY = {
    "крестьянин": "работа", "охотник": "охота", "лесоруб": "лес", "бард": "играть", "торговец": "лавка",
    "дружинник": "двор", "правитель": "обход", "рыцарь": "дозор", "стрелок": "дозор",
}

/** Житель, на которого смотрит игрок (до восьми блоков). */
function seLookedAt(p, ents) {
    var call = (o, names) => { for (var i = 0; i < names.length; i++) if (typeof o[names[i]] === "function") return Number(o[names[i]]()); return null }
    var yaw = call(p, ["getYRot", "m_146908_"]), pitch = call(p, ["getXRot", "m_146909_"])
    if (yaw === null || pitch === null) return null
    var ry = yaw * 3.141592653589793 / 180, rp = pitch * 3.141592653589793 / 180
    var lx = -Math.sin(ry) * Math.cos(rp), ly = -Math.sin(rp), lz = Math.cos(ry) * Math.cos(rp)
    var ex = p.getX(), ey = p.getEyeY(), ez = p.getZ()
    var best = null, bestCos = 0.97
    ents.forEach(e => {
        var dx = e.getX() - ex, dy = e.getY() + 1 - ey, dz = e.getZ() - ez
        var d = Math.sqrt(dx * dx + dy * dy + dz * dz)
        if (d > 8 || d < 0.1) return
        var c = (dx * lx + dy * ly + dz * lz) / d
        if (c > bestCos) { bestCos = c; best = e }
    })
    return best
}

function seCmdWork(ctx, want) {
    if (!SE_SERVER) SE_SERVER = ctx.source.getServer()
    var p = ctx.source.getPlayerOrException()
    var data = seLoad()
    var v = null, bestD = 1e18
    for (var id in data.villages) {
        var v0 = data.villages[id]
        if (seGhost(v0) || v0.dim !== String(p.level.getDimension())) continue
        var d = Math.pow(v0.x - p.getX(), 2) + Math.pow(v0.z - p.getZ(), 2)
        if (d < bestD) { bestD = d; v = v0 }
    }
    if (!v) { ctx.source.sendFailure(Text.of("Поселений поблизости нет.")); return 1 }
    var level = SE_SERVER.overworld()
    var ents = seEntities(level, v)
    var now = Number(level.getTime())
    if (want === "стоп") {
        var k = 0
        ents.forEach(e => { if (SE_FORCE[String(e.uuid)]) { delete SE_FORCE[String(e.uuid)]; k++ } })
        ctx.source.sendSuccess(Text.of("Обычный распорядок вернулся: " + k), false)
        return 1
    }
    var pick
    if (want === "этот") {
        var one = seLookedAt(p, ents)
        if (!one) { ctx.source.sendFailure(Text.of("Посмотрите на жителя поселения (до восьми блоков) и повторите.")); return 1 }
        pick = [one]
    } else {
        if (want !== "все" && !SE_WORK_DUTY[want]) {
            ctx.source.sendFailure(Text.of("§cНет такой роли: " + want + ". Можно: " + Object.keys(SE_WORK_DUTY).join(", ") + ", все, этот, стоп"))
            return 1
        }
        pick = ents.filter(e => want === "все" || seRoleOf(e) === want)
    }
    seSpots(level, v)
    var rows = []
    pick.forEach(e => {
        var u = String(e.uuid), role = seRoleOf(e)
        SE_FORCE[u] = now + SE_FORCE_TICKS
        seDropLife(v, e)
        var old = SE_JOB[u]
        if (old) { seUnhold(e, old); delete SE_JOB[u] }
        SE_CYCLE[u] = { mode: "работа", until: now + SE_FORCE_TICKS }
        var job = seMakeJob(level, v, e, role, now)
        if (job) SE_JOB[u] = job
        if (rows.length < 8) rows.push(role + " - " + (job ? job.id : SE_WORK_DUTY[role] || "дело роли"))
    })
    ctx.source.sendSuccess(Text.of(pick.length
        ? "Заняты ремеслом на десять минут: " + pick.length + "\n§7" + rows.join(", ") +
          (pick.length > rows.length ? " ..." : "") + "\n§7вернуть распорядок: /tfgvillage work стоп"
        : "§7таких жителей в поселении нет"), false)
    return 1
}

function seCmdRaid(ctx, by) {
    if (!SE_SERVER) SE_SERVER = ctx.source.getServer()
    var p = ctx.source.getPlayerOrException()
    var best = null, bestD = 1e18
    var vs = seLoad().villages
    for (var id in vs) {
        var v0 = vs[id]
        if (seGhost(v0) || v0.dim !== String(p.level.getDimension())) continue
        var d = Math.pow(v0.x - p.getX(), 2) + Math.pow(v0.z - p.getZ(), 2)
        if (d < bestD) { bestD = d; best = v0 }
    }
    if (!best) { ctx.source.sendFailure(Text.of("Поблизости нет поселений.")); return 1 }
    var ids = []
    try { ids = global.TFG_FACTIONS.list.map(f => f.id) } catch (e) { }
    if (by && ids.indexOf(by) < 0) {
        ctx.source.sendFailure(Text.of("§cНет такой фракции: " + by + ". Можно: " + ids.join(", ")))
        return 1
    }
    if (!by) { try { by = global.TFG_SIEGES.enemyOf(best.faction) } catch (e) { } }
    if (!by) by = "bandits"
    var err = global.TFG_SIEGES.start(SE_SERVER.overworld(), best, by)
    if (err) ctx.source.sendFailure(Text.of("§c" + err))
    else ctx.source.sendSuccess(Text.of("Налёт на поселение " + best.id + ": " + by + ". Отменить - /tfgvillage raid stop"), false)
    return 1
}

function seCmdRestore(ctx, faction) {
    if (!SE_SERVER) SE_SERVER = ctx.source.getServer()
    var p = ctx.source.getPlayerOrException()
    var best = null, bestD = 1e18
    var vs = seLoad().villages
    for (var id in vs) {
        var v = vs[id]
        var d = Math.pow(v.x - p.getX(), 2) + Math.pow(v.z - p.getZ(), 2)
        if (d < bestD && !seGhost(v)) { bestD = d; best = v }
    }
    if (!best) { ctx.source.sendFailure(Text.of("Поселений поблизости нет.")); return 1 }
    var level = p.level
    var msg
    if (faction === "same") {
        msg = "пересборка без смены хозяев"
    } else {
        if (faction && !seFactionRec(faction)) { ctx.source.sendFailure(Text.of("§cНет фракции " + faction)); return 1 }
        msg = "новые хозяева: " + seResettle(level, best, faction)
    }
    var n = seRebuildTick(level, best, true)
    ctx.source.sendSuccess(Text.of("Поселение " + best.id + ": " + msg + ", пересобрано построек " + n +
        ". Новые жители выйдут, когда вы отойдёте от их коек.\n§7Сила " + seVillageTier(best) + ", жителей " + best.settlers.filter(s => !s.dead).length), false)
    return 1
}

function sePlayerNear(level, village, r) {
    var near = false
    try {
        level.getServer().players.forEach(p => {
            if (String(p.level.getDimension()) !== village.dim) return
            var dx = p.getX() - village.x, dz = p.getZ() - village.z
            if (dx * dx + dz * dz < r * r) near = true
        })
    } catch (e) { }
    return near
}

// ─── Тик ─────────────────────────────────────────────────────────────────────

ServerEvents.tick(event => {
    if (!SE_SERVER) SE_SERVER = event.server
    if (event.server.tickCount % SE_TICK !== 0) return
    var data = seLoad()
    var level = event.server.overworld()
    var night = seIsNight(level)
    for (var id in data.villages) {
        var v = data.villages[id]
        try { seVillageTick(level, v, night) } catch (e) { seErr("тик " + id, e) }
    }
    try { seBuildTick(level) } catch (e) { seErr("стройка деревни", e) }
    if (seEvery(200, 140)) seSweep(level)
    try { seEntryTick(event.server, data) } catch (e) { seErr("вход в поселение", e) }
})

// ─── Чьё поселение: строка над хотбаром при входе ────────────────────────────

const SE_ENTRY_R = 110               // ближе этого к середине - игрок в поселении
var SE_INSIDE = {}                   // uuid игрока -> id поселения, где он сейчас

function seEntryTick(server, data) {
    server.players.forEach(p => {
        var u = String(p.uuid)
        var here = null
        for (var id in data.villages) {
            var v = data.villages[id]
            if (seGhost(v) || String(p.level.getDimension()) !== v.dim) continue
            var dx = p.getX() - v.x, dz = p.getZ() - v.z
            if (dx * dx + dz * dz < SE_ENTRY_R * SE_ENTRY_R) { here = v; break }
        }
        var was = SE_INSIDE[u]
        if ((here ? here.id : null) === (was || null)) return
        if (here) SE_INSIDE[u] = here.id
        else delete SE_INSIDE[u]
        if (!here) return
        var f = seFactionRec(here.faction)
        var name = here.id
        try { var site = typeof sgSiteOf === "function" ? sgSiteOf(here) : null; if (site && site.name) name = site.name } catch (e) { }
        var rep = 0
        try { rep = Math.round(Number(global.TFG_FACTIONS.rep(p, here.faction)) || 0) } catch (e) { }
        var state = here.state === "сдалось" ? " · разграблено" : here.state && here.state !== "мир" ? " · " + here.state : ""
        var line = [
            { text: "«" + name + "»", color: "white", bold: true },
            { text: "  " + (f ? f.name : "без хозяев"), color: seNameColor(here.faction) },
            { text: "  · отношение " + rep + state, color: "gray" },
        ]
        seRun("title " + p.username + " actionbar " + JSON.stringify(line))
    })
}

/**
 * Раз в period тиков (со сдвигом offset, оба кратны SE_TICK). Считаем по счётчику сервера - тому же, по которому
 * идёт тик жителей: игровое время сдвинуто относительно него как угодно, и «getTime() % 400 === 200» в тике раз
 * в секунду совпадало в одном случае из двадцати - сундуки и книги жителям почти не раздавались.
 */
function seEvery(period, offset) {
    return SE_SERVER ? Number(SE_SERVER.tickCount) % period === offset : false
}

/** Жителей, попавших в воду, - на ближайшую клетку улицы (тропы улицы, street.js), стоя на земле. */
function seOutOfWater(level, v) {
    var wet = seEntities(level, v).filter(e => { try { return e.isInWater() && e.isAlive() } catch (err) { return false } })
    if (!wet.length) return
    var cells = []
    try { cells = global.TFG_STREET.paths(v.settlement) } catch (e) { }
    wet.forEach(e => {
        var ex = Number(e.getX()), ez = Number(e.getZ())
        var best = null, bd = 1e18
        cells.forEach(c => { var d = Math.pow(c[0] - ex, 2) + Math.pow(c[1] - ez, 2); if (d < bd) { bd = d; best = c } })
        var tx = best ? Number(best[0]) : v.x, tz = best ? Number(best[1]) : v.z
        var ty = 70
        try { ty = global.TFG_STRUCTURES.top(level, tx, tz) + 1 } catch (err) { }
        try {
            e.getNavigation().stop()
            e.teleportTo(tx + 0.5, ty, tz + 0.5)
            seLog("поселение " + v.id + ": " + String(e.getName().getString()) + " вытащен из воды на улицу " + tx + " " + ty + " " + tz)
        } catch (err) { seErr("из воды", err) }
    })
}

/** Кого из живых по записи нет в мире дольше 30 секунд (кровать прогружена, не в походе) - вернуть. */
function seRespawnMissing(level, v) {
    var have = {}, now = Number(level.getTime()), n = 0
    seEntities(level, v).forEach(e => { have[seTagValue(e, "tfg_sid_")] = 1 })
    v.miss = v.miss || {}
    v.settlers.forEach(s => {
        if (s.dead || s.away || have[s.id]) { delete v.miss[s.id]; return }
        try { if (!s.bed || !level.hasChunk(s.bed.x >> 4, s.bed.z >> 4)) return } catch (e) { return }
        if (!v.miss[s.id]) { v.miss[s.id] = now; return }
        if (now - v.miss[s.id] < 600) return
        delete v.miss[s.id]
        try { if (seSpawnOne(v, s, level)) n++ } catch (e) { seErr("возврат жителя " + s.name, e) }
    })
    if (n) seLog("поселение " + v.id + ": вернулось в мир пропавших жителей " + n)
}

function seVillageTick(level, v, night) {
    if (seGhost(v)) {                                  // улицы нет - это призрак, ему тут не место
        seDrop(v, "улица " + v.settlement + " снесена")
        return
    }
    if (v.rebuildPending) seRebuildTick(level, v, false)
    // поселениям, построенным раньше, свои сундуки раздаём один раз, когда они прогружены целиком
    if (!v.chestsDone && seEvery(400, 0) && seLoadedAround(level, v)) {
        try {
            var stc = global.TFG_STREET.list()[v.settlement]
            var got = seAssignChests(level, stc, v.settlers)
            v.chestsDone = true
            seSave()
            seLog("поселение " + v.id + ": своих сундуков жителям " + got + " из " + v.settlers.length)
        } catch (e) { seErr("сундуки жителей", e) }
    }
    // правитель остался без сундука (старые поселения: раздавали без очереди) - ещё раз, ему первому и шире;
    // если книги уже разложены - его дневник кладём сразу
    var rulerNoChest = v.chestsDone && v.settlers.filter(s => s.role === "правитель" && !s.dead && !s.chest)[0]
    if (rulerNoChest && !v.rulerChestTried && seEvery(400, 100) && seLoadedAround(level, v)) {
        try {
            v.rulerChestTried = true
            seAssignChests(level, global.TFG_STREET.list()[v.settlement], v.settlers)
            if (rulerNoChest.chest && v.booksDone) lbInsert(level, rulerNoChest.chest, global.TFG_BOOKS.diary(level, v, rulerNoChest))
            seSave()
            seLog("поселение " + v.id + ": сундук правителю " + (rulerNoChest.chest ? "нашёлся" : "не нашёлся"))
        } catch (e) { seErr("сундук правителя", e) }
    }
    // книги и дневники - в личные сундуки, один раз, когда сундуки розданы и поселение прогружено (books.js)
    if (v.chestsDone && !v.booksDone && seEvery(400, 200) && seLoadedAround(level, v)) {
        try { global.TFG_BOOKS.place(level, v) } catch (e) { seErr("книги", e) }
        v.booksDone = true
        v.diariesV3 = true                             // дневники уже по дням
        seSave()
    }
    // старые короткие дневники - на дневники по дням, один раз (diaries.js)
    if (v.booksDone && !v.diariesV3 && seEvery(400, 260) && seLoadedAround(level, v)) {
        try { global.TFG_DIARIES.refresh(level, v) } catch (e) { seErr("обновление дневников", e) }
        v.diariesV3 = true
        seSave()
    }
    // памятные гравированные вещи - тоже в личные сундуки, один раз (engraving.js)
    if (v.booksDone && !v.heirloomsDone && seEvery(400, 300) && seLoadedAround(level, v)) {
        try { global.TFG_ENGRAVE.place(level, v) } catch (e) { seErr("памятные вещи", e) }
        v.heirloomsDone = true
        seSave()
    }
    // вода в черте поселения - под саман (street.js); у старых поселений - по мере прогрузки участков
    if (!v.waterFilled && v.settlement && seEvery(400, 60) && seLoadedAround(level, v)) {
        try { if (global.TFG_STREET.fillWater(level, v.settlement)) { v.waterFilled = true; seSave() } } catch (e) { seErr("засыпка воды", e) }
    }
    // житель в воде - на ближайшую улицу: из оврагов и прудов они сами не выбираются
    if (seEvery(40, 20) && sePlayerNear(level, v, 160)) seOutOfWater(level, v)
    // казна правителя и тайники жителей (stashes.js): заложить, следить, откатить разграбленное
    if (v.heirloomsDone && seEvery(200, 100) && seLoadedAround(level, v)) global.TFG_STASH.tick(level, v)
    // разграбленное заселяют и тогда, когда игроки живут рядом (присмотр seUpkeep идёт только у пустого,
    // незаселённого поселения - рядом с игроками он не наступал никогда): прошло SE_RESETTLE_DAYS суток и в
    // SE_RESETTLE_NEAR блоках никого - недобитки уходят, приходят новые хозяева, постройки встают заново
    if (v.state === "сдалось" && seEvery(200, 0) &&
        Number(level.getTime()) - (v.surrenderAt || 0) >= SE_RESETTLE_DAYS * SE_DAY && !sePlayerNear(level, v, SE_RESETTLE_NEAR)) {
        try { seResettle(level, v) } catch (e) { seErr("заселение разграбленного", e) }
        return
    }
    try { seTankFixTick(level, v) } catch (e) { seErr("бак промзоны", e) }
    try { seHuntReturnTick(level, v) } catch (e) { seErr("охотник домой", e) }
    try { seYardTick(level, v) } catch (e) { seErr("двор крепости", e) }
    if (!v.spawned) {
        seUpkeep(level, v, false)
        return
    }
    // житель пропал из мира (его убрала чистка или откат) - при игроке рядом вернуть к кровати
    if (seEvery(200, 40) && sePlayerNear(level, v, 96)) seRespawnMissing(level, v)
    var ents = seEntities(level, v)
    if (!ents.length) return

    // враг рядом? любой житель, заметивший чужого, поднимает тревогу
    var threat = seNearestThreat(level, v)
    if (threat && v.state === "мир") seAlarm(v, "враг замечен")
    if (!threat && (v.state === "тревога" || v.state === "осада" || v.state === "вылазка")) {
        v.state = "мир"
        v.hornN = 0
        ents.forEach(e => { try { e.setTarget(null) } catch (err) { } })
        seSay(v, "отбой", v.x, 80, v.z)
        seSave()
    }
    // враг дошёл до кольца - это уже осада: дружина к воротам, стрелки на стены
    if (v.state === "тревога" && threat) {
        var adx = threat.getX() - v.x, adz = threat.getZ() - v.z
        if (adx * adx + adz * adz < Math.pow((v.ring || 28) + 16, 2)) {
            v.state = "осада"
            v.alarmAt = Number(level.getTime())
            seSay(v, "осада", v.x, 80, v.z)
            seSave()
        }
    }
    // враг топчется - гарнизон идёт сам
    if (v.state === "осада" && threat && Number(level.getTime()) - (v.alarmAt || 0) > SE_SORTIE_AFTER) {
        v.state = "вылазка"
        seSay(v, "вылазка", v.x, 80, v.z)
        seSave()
    }
    seCheckSurrender(v)

    // Зверьё у поселения - забота стражи и дружины. Остальные работают дальше:
    // от зомби поселение не запирается, иначе жизнь встанет каждую ночь.
    var monster = v.state === "мир" ? seMonster(level, v) : null
    if (!monster && v.hadMonster) { seSay(v, "отбой_зверь", v.x, 80, v.z); v.hadMonster = false }
    if (monster) v.hadMonster = true

    // На зверьё отзываются только ближайшие трое из стражи: остальным незачем
    // бросать дела и носиться через всё поселение.
    var answer = {}
    if (monster) {
        var near = []
        ents.forEach(e => {
            if (SE_FIGHTERS.indexOf(seRoleOf(e)) < 0) return
            var dx = e.getX() - monster.getX(), dz = e.getZ() - monster.getZ()
            near.push({ u: String(e.uuid), d: dx * dx + dz * dz })
        })
        near.sort((a, b) => a.d - b.d)
        near.slice(0, 3).forEach(o => { if (o.d < 64 * 64) answer[o.u] = 1 })
    }

    seRelight(level, v)                                // раз в десять минут - пересветка фонарей
    seSpots(level, v)                                  // где тут грядки и лес
    seScan(level, v, ents)                             // и где стулья, очаги и берега (поиск гостей)

    ents.forEach(e => {
        // без рыка: список подмены звуков (RAID_HUSKS) обнуляется каждым /reload - записываем заново
        if (typeof gsHuskVoice === "function") gsHuskVoice(e)
        var role = seRoleOf(e)
        var sid = seSidOf(e)
        var rec = v.settlers.filter(x => x.id === sid)[0]
        var duty = seDuty(v, role, sid, night, rec ? rec.shift : undefined)
        if (monster && answer[String(e.uuid)] && duty !== "спать") duty = "на помощь"
        // показ ремесла (/tfgvillage work): в мирное время - только своё дело, в любой час
        var fu = String(e.uuid)
        if (SE_FORCE[fu]) {
            if (Number(level.getTime()) > SE_FORCE[fu]) delete SE_FORCE[fu]
            else if (v.state === "мир" && SE_WORK_DUTY[role]) duty = SE_WORK_DUTY[role]
        }
        // занят торгом в форте (factions/fairs.js) - распорядок подождёт
        var held = false
        try { held = typeof frHolds === "function" && frHolds(e) } catch (err) { }
        // В разговоре или сделке с игроком (factions/npc_hold.js) житель стоит и смотрит на
        // собеседника, как гость: никаких дел, прыжков и переносов «из застревания».
        var talking = false
        try { talking = global.TFG_NPC_HOLD.isHeld(e) } catch (err) { }
        if (talking) return
        // занят сценой (торг, аудиенция) - его ведёт factions/fairs.js: никаких своих дел,
        // ни вытаскивания «из застревания», ни присмотра - стоит на месте и беседует
        if (held) return
        try { seEvac(level, v, e) } catch (err) { seErr("выход из дома", err) }
        try { seAct(level, v, e, role, duty, threat || monster, ents) } catch (err) { seErr("занятие " + role, err) }
        try { seStuck(e, v) } catch (err) { seErr("застревание", err) }
        try { seWatch(level, v, e, duty) } catch (err) { seErr("присмотр", err) }
    })
    seReport(level, v, ents)
    seSaidTick(level, ents)
    seDoorsTick(level)
}

// кто бросает дела ради драки
const SE_FIGHTERS = ["рыцарь", "стрелок", "дружинник"]

/**
 * Враг поселения - это налётчик чужой фракции или игрок, которого здесь объявили
 * врагом. Зомби и прочая нежить тревоги НЕ поднимают: жизнь идёт своим чередом,
 * а разбираться с ними бегут только стража и дружина (см. seMonster).
 */
var SE_THREATS = {}                  // id поселения -> враги этого тика (живые сущности, в данные не пишем)

/** Забыть враждебность игроков, которые давно ничего не делали поселению. */
function seForgetHostile(level, v) {
    if (!v.threat) return
    var now = Number(level.getTime()), changed = false
    for (var u in v.threat) {
        var t = v.threat[u]
        if (t.hostile && now - (t.at || 0) > SE_HOSTILE_FORGET) { delete v.threat[u]; changed = true }
    }
    if (changed) seSave()
}

/** Ближайший к этому жителю враг поселения из списка тика. */
function seThreatFor(v, e) {
    var list = SE_THREATS[v.id] || []
    var best = null, bestD = 1e18
    list.forEach(t => {
        try {
            if (!t.isAlive()) return
            var d = Math.pow(t.getX() - e.getX(), 2) + Math.pow(t.getZ() - e.getZ(), 2)
            if (d < bestD) { bestD = d; best = t }
        } catch (err) { }
    })
    return best
}

function seNearestThreat(level, v) {
    seForgetHostile(level, v)
    var all = SE_THREATS[v.id] = []
    var best = null, bestD = SE_ALARM_RADIUS * SE_ALARM_RADIUS
    try {
        var list = level.getEntities()
        for (var i = 0; i < list.size(); i++) {
            var e = list.get(i)
            if (!e) continue
            var enemy = false
            try {
                if (e.getTags && e.getTags().contains("tfg_raider")) enemy = true
                else if (String(e.type) === "minecraft:player" && v.threat) {
                    var t = v.threat[String(e.uuid)]
                    enemy = !!(t && t.hostile)
                }
            } catch (e2) { continue }
            if (!enemy) continue
            if (e.getTags && e.getTags().contains("tfg_settler")) continue
            try { if (!e.isAlive()) continue } catch (e3) { continue }      // павший враг тревоги не держит
            var dx = e.getX() - v.x, dz = e.getZ() - v.z
            var d = dx * dx + dz * dz
            if (d < SE_ALARM_RADIUS * SE_ALARM_RADIUS) all.push(e)
            if (d < bestD) { bestD = d; best = e }
        }
    } catch (err) { }
    return best
}

// кого стража считает зверьём и гонит от поселения
const SE_MONSTERS = ["minecraft:zombie", "minecraft:husk", "minecraft:drowned", "minecraft:skeleton",
    "minecraft:stray", "minecraft:spider", "minecraft:cave_spider", "minecraft:creeper", "minecraft:witch",
    "minecraft:pillager", "minecraft:vindicator", "minecraft:ravager"]
const SE_MONSTER_R = 44              // ближе этого к середине поселения - уже наглость

/** Ближайшее зверьё у поселения. Тревогу не поднимает - только зовёт стражу. */
function seMonster(level, v) {
    var best = null, bestD = SE_MONSTER_R * SE_MONSTER_R
    try {
        var list = level.getEntities()
        for (var i = 0; i < list.size(); i++) {
            var e = list.get(i)
            if (!e) continue
            if (SE_MONSTERS.indexOf(String(e.type)) < 0) continue
            if (!e.isAlive()) continue
            try { if (e.getTags && (e.getTags().contains("tfg_npc") || e.getTags().contains("tfg_settler"))) continue } catch (e2) { continue }
            // Под землёй пусть сидит сколько хочет: стража гоняется за зомби в пещере,
            // и со стороны это выглядит дракой с воздухом.
            var surf = 0
            try { surf = Number(level.getHeight("WORLD_SURFACE_WG", Math.floor(e.getX()), Math.floor(e.getZ()))) } catch (e3) { continue }
            if (e.getY() < surf - 5) continue
            var dx = e.getX() - v.x, dz = e.getZ() - v.z
            var d = dx * dx + dz * dz
            if (d < bestD) { bestD = d; best = e }
        }
    } catch (err) { }
    return best
}

/** Куда идти и что делать - по занятию. */
/**
 * Бой ведём тем же мозгом, что и рейдеры (tfg/raids.js): он уже умеет держать полосу
 * дистанции по оружию, искать укрытие, не стрелять на бегу и сам стреляет из TACZ
 * через raidFireTick. Своего боевого ИИ у жителей нет - и не нужно: стрелок,
 * бегущий в упор на игрока, это ровно то, на что жаловались.
 * true - бой ведётся, движение уже задано; false - цель потеряна.
 */
function seFight(e, target) {
    if (!target || !target.isAlive()) return false
    try {
        if (typeof raidCombatTick === "function") return !!raidCombatTick(e, target)
    } catch (err) { seErr("бой", err) }
    try { e.setTarget(target) } catch (err) { }
    return false
}

var SE_CYCLE = {}                    // uuid -> { mode: "работа"|"отдых", until }
const SE_TIRELESS = ["крестьянин", "лесоруб", "охотник"]
const SE_EVENING_FROM = 11000        // с этого часа мирные собираются послушать барда
const SE_LISTENERS = ["крестьянин", "лесоруб", "охотник", "дружинник", "торговец"]

/**
 * Мирный день: житель то работает по своей роли, то живёт распорядком гостей
 * (сидит, греется у огня, ест, удит, беседует). Работа идёт часа полтора игровых,
 * потом перерыв - иначе крестьянин сутками тяпает одну и ту же грядку.
 */
// ─── Поход охотника ──────────────────────────────────────────────────────────
//
// На рассвете охотник уходит на весь день за километры: выбирает сторону, идёт из поселения и,
// отойдя за SE_TRIP_LEAVE блоков, пропадает из мира (как житель, ушедший с караваном: rec.away).
// К вечеру возвращается с той же стороны - появляется на краю поселения и идёт домой.

const SE_TRIP_DAWN = 2500            // до этого часа суток (после рассвета) охотник выходит в поход
const SE_TRIP_LEAVE = 110            // отойдя так далеко от середины поселения, уходит из мира
const SE_TRIP_BACK = 11500           // вернётся к этому часу суток (вечер)
var SE_TRIP = {}                     // uuid -> { ang, tx, tz, at }

function seHuntTrip(level, v, e, speed) {
    var u = String(e.uuid)
    var rec = v.settlers.filter(x => x.id === seSidOf(e))[0]
    if (!rec || rec.away) return false
    var dt = Number(level.getDayTime()), today = Math.floor(dt / 24000), hour = dt % 24000
    var t = SE_TRIP[u]
    if (!t) {
        if (hour > SE_TRIP_DAWN || rec.huntDay === today) return false
        var ang = Math.random() * 6.283185307179586
        var far = 1000 + Math.random() * 2000
        t = SE_TRIP[u] = { ang: ang, tx: v.x + Math.cos(ang) * far, tz: v.z + Math.sin(ang) * far, at: Number(level.getTime()) }
        rec.huntDay = today
        seSave()
        seSay(v, "охота", e.getX(), e.getY(), e.getZ())
    }
    var dx = e.getX() - v.x, dz = e.getZ() - v.z
    // ушёл далеко (или застрял надолго) - дальше его путь вне мира
    if (dx * dx + dz * dz > SE_TRIP_LEAVE * SE_TRIP_LEAVE || Number(level.getTime()) - t.at > 4800) {
        rec.away = "охота"
        rec.goneBody = true
        rec.huntBack = today * 24000 + SE_TRIP_BACK + Math.floor(Math.random() * 1500)
        rec.huntAng = t.ang
        delete SE_TRIP[u]
        try { e.discard() } catch (err) { }
        seSave()
        seLog("поселение " + v.id + ": " + rec.name + " ушёл на охоту до вечера")
        return true
    }
    seGoFar(e, v, t.tx, t.tz, speed * 1.1)
    return true
}

/** Вечер: охотник возвращается из похода - с края поселения, с той стороны, куда уходил. */
function seHuntReturnTick(level, v) {
    var dt = Number(level.getDayTime())
    var changed = false
    v.settlers.forEach(s => {
        if (s.dead || s.away !== "охота" || dt < (s.huntBack || 0)) return
        delete s.away
        delete s.goneBody
        var a = s.huntAng || 0
        s.enterAt = { x: Math.round(v.x + Math.cos(a) * (SE_TRIP_LEAVE - 15)), z: Math.round(v.z + Math.sin(a) * (SE_TRIP_LEAVE - 15)) }
        s.newcomer = true
        changed = true
        var lucky = Math.random() < 0.7
        try { sgEvent(v, "охота", s.name + (lucky ? " вернулся с охоты с добычей" : " вернулся с охоты ни с чем")) } catch (e) { }
    })
    if (changed) seSave()
}

function seWorkTick(level, v, e, role, speed, ents) {
    var u = String(e.uuid), now = Number(level.getTime())
    if (role === "охотник" && seHuntTrip(level, v, e, speed)) return
    var c = SE_CYCLE[u]
    // крестьяне, лесорубы и охотники днём не отдыхают гостями: они всегда при деле
    if (SE_TIRELESS.indexOf(role) >= 0 && (!c || c.mode !== "работа")) {
        c = SE_CYCLE[u] = { mode: "работа", until: now + 24000 }
        seDropLife(v, e)
    }
    if (!c || now >= c.until) {
        var wasWork = c && c.mode === "работа"
        c = SE_CYCLE[u] = {
            mode: wasWork ? "отдых" : "работа",
            until: now + (wasWork ? 600 + Math.floor(Math.random() * 900) : 1200 + Math.floor(Math.random() * 1200)),
        }
        if (c.mode === "работа") seDropLife(v, e)
        else { var old = SE_JOB[u]; if (old) { seUnhold(e, old); delete SE_JOB[u] } }
    }
    if (c.mode === "отдых") {
        var j2 = SE_JOB[String(e.uuid)]
        if (!j2 || j2.id !== "охота") { try { e.setTarget(null) } catch (err) { } }
        seLife(level, v, e, ents)
        return
    }

    var j = SE_JOB[u]
    if (j && now < j.until && (j.id !== "охота" || (j.target && j.target.isAlive()))) {
        seJobTick(level, v, e, j, now, role, speed)
        return
    }
    if (j) { seUnhold(e, j); delete SE_JOB[u]; try { e.setTarget(null) } catch (err) { } }
    var made = seMakeJob(level, v, e, role, now)
    if (!made) { seLife(level, v, e, ents); return }      // работы нет - живём как гости
    SE_JOB[u] = made
    seJobTick(level, v, e, made, now, role, speed)
}

function seAct(level, v, e, role, duty, threat, ents) {
    var speed = (SE_ROLES[role] || SE_ROLES["крестьянин"]).speed
    // куда вытаскивать, если застрянет: по умолчанию на тропу
    var mv = SE_MOVE[String(e.uuid)]
    if (mv) mv.rescue = null
    // Бег снимаем на каждом шаге: кто побежал однажды (удирая в форт), тот оставался
    // бегущим навсегда. Обратно его включит только seMove, и только на быстрых делах.
    try { e.setSprinting(false) } catch (err) { }
    // Бой в поселении - главное дело стражи и дружины: каждый идёт на ближайшего к себе
    // врага, где бы тот ни был в поселении, и бьёт, пока враги не кончатся.
    if (SE_FIGHTERS.indexOf(role) >= 0 && (v.state === "тревога" || v.state === "осада" || v.state === "вылазка")) {
        var foe = seThreatFor(v, e)
        if (foe) {
            if (!seFight(e, foe)) seGo(e, v, foe.getX(), foe.getZ(), speed * 1.6)
            return
        }
    }
    switch (duty) {
        case "спать":
            // к своей койке; спать по-настоящему мобы не умеют, но место занимают
            var bed = seBedOf(v, e)
            if (bed) {
                seGo(e, v, bed.x + 0.5, bed.z + 0.5, speed)
                var bm = SE_MOVE[String(e.uuid)]
                if (bm) bm.rescue = { x: bed.x, y: bed.y, z: bed.z }
            }
            return
        case "трубить":
            // есть колокол во дворе - правитель у него и бьёт без остановки, пока идёт бой
            if (v.yard && v.yard.bell) { seBellTick(level, v, e, speed * 1.4); return }
            // Рог - сигнал, а не музыка: раз в десять секунд и не больше десяти раз
            // за тревогу. Иначе правитель дудит без умолку, на что и жаловались.
            var tNow = Number(level.getTime())
            if (tNow - (v.hornAt || 0) > 200 && (v.hornN || 0) < 10) {
                v.hornAt = tNow
                v.hornN = (v.hornN || 0) + 1
                seRun("execute in " + v.dim + " positioned " + Math.round(e.getX()) + " " + Math.round(e.getY()) + " " +
                    Math.round(e.getZ()) + " run playsound minecraft:item.goat_horn.sound.1 hostile @a[distance=..120] ~ ~ ~ 2 0.9")
            }
            seFortRun(e, v, speed * 1.8)
            return
        case "в форт":
        case "прятаться":
            // бегут, потому что спасаются, - это один из двух случаев, когда бег уместен
            seFortRun(e, v, speed * 1.8)
            // в форте гарнизон бьёт того, кто вошёл следом
            if (threat && SE_FIGHTERS.indexOf(role) >= 0) {
                var tdx = e.getX() - threat.getX(), tdz = e.getZ() - threat.getZ()
                if (tdx * tdx + tdz * tdz < 24 * 24 && seFight(e, threat)) return
            }
            if (Math.random() < 0.03) seSay(v, "тревога", e.getX(), e.getY(), e.getZ())
            return
        case "на помощь":
            if (threat) {
                if (!seFight(e, threat)) seGo(e, v, threat.getX(), threat.getZ(), speed * 1.7)
                if (Math.random() < 0.04) seSay(v, "монстры", e.getX(), e.getY(), e.getZ())
            }
            return
        case "ворота":
            // на свой пост идут шагом: бег бережём для бегства и для драки
            // враг на виду - бой; нет - стоим на посту у ворот
            if (threat && seFight(e, threat)) return
            var gsp = seFortSpot(v)
            if (gsp) seGo(e, v, gsp.gate.x + 0.5 + (Math.random() - 0.5) * 4, gsp.gate.z + 0.5 + (Math.random() - 0.5) * 4, speed)
            else seGo(e, v, v.x, v.z + (v.ring || 28) * 0.4, speed)
            return
        case "стена":
            // стрелок на стене: пока враг виден - работает мозг рейдеров (укрытие и огонь)
            if (threat && seFight(e, threat)) return
            var wsp = seFortSpot(v)
            if (wsp) seGo(e, v, wsp.inside.x + (Math.random() - 0.5) * 10, wsp.inside.z + (Math.random() - 0.5) * 10, speed)
            else seGo(e, v, v.x, v.z, speed)
            return
        case "вылазка":
            if (threat && !seFight(e, threat)) seGo(e, v, threat.getX(), threat.getZ(), speed * 1.7)
            return
        case "сдаться":
            e.setTarget(null)
            return
        case "разойтись":
            // от койки - на улицу, к вехам троп: видно сразу, что поселение живое
            seWander(e, v, (v.ring || 28) + 16, speed)
            if (Math.random() < 0.02) seSay(v, "утро", e.getX(), e.getY(), e.getZ())
            return
        case "дозор":
            seWander(e, v, (v.ring || 28) + 24, speed)
            return
        case "обход":
            // правитель ходит по двору своей крепости: от точки к точке, с остановками
            seRulerWalk(level, v, e, speed)
            if (Math.random() < 0.006) seSay(v, "день", e.getX(), e.getY(), e.getZ())
            return
        case "слушать":
            seListen(level, v, e, ents, speed)
            return
        case "форт":
            seWander(e, v, (v.ring || 28) * 0.6, speed)
            return
        case "охота":
            seWorkTick(level, v, e, role, speed, ents)
            if (Math.random() < 0.01) seSay(v, "охота", e.getX(), e.getY(), e.getZ())
            return
        case "лес":
            seWorkTick(level, v, e, role, speed, ents)
            if (Math.random() < 0.01) seSay(v, "лес", e.getX(), e.getY(), e.getZ())
            return
        case "играть":
            seBardPerform(level, v, e, ents, speed)
            return
        case "бард днём":
            // днём бард не играет: гуляет, сидит, греется - как гости
            seStopPlay(String(e.uuid))
            seLife(level, v, e, ents)
            return
        case "лавка":
            // днём - за своим прилавком во дворе крепости; вечером его позовёт бард (seDuty)
            var stall = seStallOf(v, e)
            if (stall) { seStallTick(level, v, e, stall, speed); return }
            seWorkTick(level, v, e, role, speed, ents)
            if (Math.random() < 0.01) seSay(v, "торг", e.getX(), e.getY(), e.getZ())
            return
        default:
            // крестьянин, дружинник, правитель: работа по поселению и жизнь между делом
            seWorkTick(level, v, e, role, speed, ents)
            if (Math.random() < 0.01) {
                var t = Number(level.getDayTime()) % SE_DAY
                seSay(v, t < 4000 ? "утро" : t < 9000 ? "день" : t < SE_NIGHT_FROM ? "вечер" : "ночь",
                    e.getX(), e.getY(), e.getZ())
            }
            return
    }
}

/**
 * Где у форта ворота и где внутренний двор. Бежать «в точку посреди форта» нельзя:
 * высота этой точки - крыша, навигация такой путь не строит, и житель топчется у стены.
 * Поэтому сперва ворота (они на уровне земли), а от них - внутрь.
 */
var SE_PATROL = {}                   // uuid правителя -> { x, z, until } - куда идёт по двору

function seRulerWalk(level, v, e, speed) {
    var u = String(e.uuid), now = Number(level.getTime())
    var fs = seFortSpot(v)
    if (!fs) { seWander(e, v, 10, speed * 0.8); return }
    var yard = seFortYard(level, fs)
    if (!yard) { seWander(e, v, 10, speed * 0.8); return }
    var inYard = e.getX() >= yard.x1 && e.getX() <= yard.x2 + 1 && e.getZ() >= yard.z1 && e.getZ() <= yard.z2 + 1
    if (!inYard) { seFortRun(e, v, speed); return }         // сперва во двор - тем же путём, что все
    var p = SE_PATROL[u]
    if (!p || now >= p.until) {
        p = SE_PATROL[u] = {
            x: yard.x1 + Math.random() * (yard.x2 - yard.x1 + 1), z: yard.z1 + Math.random() * (yard.z2 - yard.z1 + 1),
            until: now + 200 + Math.floor(Math.random() * 300),      // дошёл - постоит, потом дальше
        }
    }
    var dx = e.getX() - p.x, dz = e.getZ() - p.z
    // по двору напрямую: вехи троп снаружи, через них правитель уходил за ворота
    if (dx * dx + dz * dz > 2.25) seMove(e, p.x, fs.insideY !== null ? fs.insideY : e.getY(), p.z, speed * 0.8)
    else { try { e.getNavigation().stop() } catch (err) { } }
}

/**
 * Место выступления барда: на улице перед воротами крепости, шагах в десяти от них, на
 * клетке тропы - туда к вечеру и сходятся слушатели. Ищется один раз и запоминается.
 */
function seStage(v) {
    // есть костёр во дворе крепости - бард играет у него
    if (v.yard && v.yard.fire) return { x: v.yard.fire.x + 1, z: v.yard.fire.z, fort: true }
    if (v.stage) return v.stage
    var st = seStreet(v)
    var paths = st && st.paths || []
    if (!paths.length) return null
    var fs = seFortSpot(v)
    var cx = fs ? fs.gate.x : v.x, cz = fs ? fs.gate.z : v.z
    var want = fs ? 10 : (v.ring || 28)
    var best = null, bestS = 1e18
    paths.forEach(c => {
        var d = Math.sqrt(Math.pow(c[0] - cx, 2) + Math.pow(c[1] - cz, 2))
        var s = Math.abs(d - want)
        if (s < bestS) { bestS = s; best = c }
    })
    if (!best) return null
    v.stage = { x: Number(best[0]), z: Number(best[1]) }
    seSave()
    return v.stage
}

const SE_AUDIENCE_R = 7              // слушатель ближе этого к барду - бард играет

/** Вечер: бард идёт на своё место на улице и играет, только пока его слушают. */
function seBardPerform(level, v, e, ents, speed) {
    var u = String(e.uuid)
    var sg = seStage(v)
    if (!sg) { seStopPlay(u); seLife(level, v, e, ents); return }
    var dx = e.getX() - (sg.x + 0.5), dz = e.getZ() - (sg.z + 0.5)
    if (dx * dx + dz * dz > 4) {
        seStopPlay(u)                                  // по дороге не играет
        if (sg.fort) seGoFort(e, v, sg.x + 0.5, sg.z + 0.5, speed)
        else seGo(e, v, sg.x + 0.5, sg.z + 0.5, speed)
        return
    }
    try { e.getNavigation().stop() } catch (err) { }
    var audience = ents.filter(o => o !== e && o.isAlive() && seRoleOf(o) !== "бард" &&
        Math.pow(o.getX() - e.getX(), 2) + Math.pow(o.getZ() - e.getZ(), 2) < SE_AUDIENCE_R * SE_AUDIENCE_R)
    // некому слушать - ждёт молча (кроме показа ремесла по команде)
    if (!audience.length && !(SE_FORCE[u] > Number(level.getTime()))) { seStopPlay(u); return }
    if (!audience.length) audience = [e]
    try { e.getLookControl().setLookAt(audience[0].getX(), audience[0].getEyeY(), audience[0].getZ()) } catch (err) { }
    seTune(level, v, e)
    if (Math.random() < 0.01) seSay(v, Math.random() < 0.6 ? "бард" : "бард_хвала", e.getX(), e.getY(), e.getZ())
}

/** Слушатель барда: встаёт в круг вокруг него (каждый на своё место) и смотрит на певца. */
function seListen(level, v, e, ents, speed) {
    var bard = null
    for (var i = 0; i < ents.length; i++) if (seRoleOf(ents[i]) === "бард" && ents[i].isAlive()) { bard = ents[i]; break }
    if (!bard) { seWander(e, v, (v.ring || 28) * 0.6, speed); return }
    var u = String(e.uuid), h = 0
    for (var k = 0; k < u.length; k++) h = (h * 31 + u.charCodeAt(k)) % 3600
    var a = h / 3600 * 6.283185307179586, r = 3 + (h % 3)
    // круг - у места выступления на улице, а не там, где бард сейчас прогуливается
    var sg = seStage(v)
    var cx = sg ? sg.x + 0.5 : bard.getX(), cz = sg ? sg.z + 0.5 : bard.getZ()
    // у костра в крепости - круг вокруг самого огня, вплотную к нему
    if (sg && sg.fort) { cx = v.yard.fire.x + 0.5; cz = v.yard.fire.z + 0.5; r = 2 + (h % 2) }
    var tx = cx + Math.cos(a) * r, tz = cz + Math.sin(a) * r
    var dx = e.getX() - tx, dz = e.getZ() - tz
    if (dx * dx + dz * dz > 2.25) { if (sg && sg.fort) seGoFort(e, v, tx, tz, speed); else seGo(e, v, tx, tz, speed); return }
    try { e.getNavigation().stop() } catch (err) { }
    try { e.getLookControl().setLookAt(bard.getX(), bard.getEyeY(), bard.getZ()) } catch (err) { }
}

function seFortSpot(v) {
    if (v.fort && v.fort.gate && v.fort.box) return v.fort
    var f = null
    try {
        var st = global.TFG_STREET.list()[v.settlement]
        f = st && st.buildings.filter(b => b.type === "форт")[0]
    } catch (e) { }
    if (!f) return null
    var d = f.door
    v.fort = {
        gate: d ? { x: Math.round(d.x), y: Math.round(d.y), z: Math.round(d.z) }
                : { x: v.x, y: f.y + 1, z: v.z },
        inside: { x: Math.round(f.x + f.size[0] / 2), y: f.y + 1, z: Math.round(f.z + f.size[2] / 2) },
        box: { x1: f.x, z1: f.z, x2: f.x + f.size[0] - 1, z2: f.z + f.size[2] - 1 },
    }
    seSave()
    return v.fort
}

var SE_HIDE = {}                     // uuid -> { x, z, until } - куда тихо идёт по двору крепости

/**
 * Двор крепости - открытая площадка за стенами, промеренная по миру от середины форта.
 * Коробка шаблона для этого не годится: стены и угловые башни у форта толщиной в три-шесть
 * блоков, и точка «где-то в коробке» то и дело попадала в стену - житель упирался в неё
 * и так и топтался у ворот, не заходя во двор.
 */
const SE_YARD_MEASURE = 2            // версия замера двора: старые замеры (сквозь ворота) пересчитать

function seFortYard(level, sp) {
    if (sp.yard && sp.yardVer === SE_YARD_MEASURE) return sp.yard
    if (sp.insideY === undefined || sp.insideY === null) {
        sp.insideY = null
        for (var dy = -1; dy <= 6 && sp.insideY === null; dy++) {
            if (seStandable(level, sp.inside.x, sp.inside.y + dy, sp.inside.z)) sp.insideY = sp.inside.y + dy
        }
        if (sp.insideY === null) return null               // чанк ещё не прогружен - спросим потом
    }
    var y0 = sp.insideY
    var open = (x, z) => seStandable(level, x, y0, z) || seStandable(level, x, y0 + 1, z) || seStandable(level, x, y0 - 1, z)
    // Луч в сторону ворот уходил сквозь проём наружу, и «двор» захватывал площадку перед
    // воротами. Поэтому меряем семью параллельными лучами и берём самый короткий: проём
    // ворот (четыре блока) так не проскочить, его закрывают соседние лучи у стены.
    var reach = (dx, dz) => {
        var best = 20
        for (var off = -3; off <= 3; off++) {
            var bx = sp.inside.x + (dx ? 0 : off), bz = sp.inside.z + (dz ? 0 : off)
            var n = 0
            while (n < 20 && open(bx + dx * (n + 1), bz + dz * (n + 1))) n++
            if (n < best) best = n
        }
        return best
    }
    var e = reach(1, 0), w = reach(-1, 0), s = reach(0, 1), nn = reach(0, -1)
    if (e + w < 4 || s + nn < 4) return null              // так мал двор не бывает - мир не дорисован, промерим позже
    // по клетке от стен: у самой стены житель цепляется за неё боком
    sp.yard = {
        x1: sp.inside.x - Math.max(0, w - 1), x2: sp.inside.x + Math.max(0, e - 1),
        z1: sp.inside.z - Math.max(0, nn - 1), z2: sp.inside.z + Math.max(0, s - 1),
    }
    sp.yardVer = SE_YARD_MEASURE
    seSave()
    return sp.yard
}

// ─── Места во дворе: жителей много - пусть стоят по всему форту, а не толпой у костра ───

var SE_FORT_CELLS = {}               // id поселения -> [{x, z}] - проходимые клетки двора

/** Все проходимые клетки форта заливкой от середины двора: не у ворот, не у огня и не вплотную к стене. */
function seFortCells(level, v, sp) {
    var have = SE_FORT_CELLS[v.id]
    if (have && have.length) return have
    if (sp.insideY === null || sp.insideY === undefined || !sp.box) return []
    var y0 = sp.insideY
    var open = (x, z) => seStandable(level, x, y0, z) || seStandable(level, x, y0 + 1, z) || seStandable(level, x, y0 - 1, z)
    var b = sp.box, seen = {}, queue = [[sp.inside.x, sp.inside.z]], out = []
    var fire = v.yard && v.yard.fire ? v.yard.fire : null
    seen[sp.inside.x + "," + sp.inside.z] = 1
    while (queue.length && out.length < 3000) {
        var c = queue.shift(), x = c[0], z = c[1]
        var walled = !open(x + 1, z) || !open(x - 1, z) || !open(x, z + 1) || !open(x, z - 1)
        var nearGate = Math.pow(x - sp.gate.x, 2) + Math.pow(z - sp.gate.z, 2) < 49
        var nearFire = fire && Math.pow(x - fire.x, 2) + Math.pow(z - fire.z, 2) < 9
        if (!walled && !nearGate && !nearFire) out.push({ x: x + 0.5, z: z + 0.5 })
        ;[[1, 0], [-1, 0], [0, 1], [0, -1]].forEach(d => {
            var nx = x + d[0], nz = z + d[1], k = nx + "," + nz
            if (seen[k] || nx < b.x1 || nx > b.x2 || nz < b.z1 || nz > b.z2) return
            seen[k] = 1
            // за ворота наружу заливка не уходит
            if (Math.pow(nx - sp.gate.x, 2) + Math.pow(nz - sp.gate.z, 2) < 2) return
            if (open(nx, nz)) queue.push([nx, nz])
        })
    }
    if (out.length >= 5) SE_FORT_CELLS[v.id] = out
    return out
}

/** Своё место во дворе: подальше (от двух блоков) от мест, куда уже идут другие. */
function seHideSpot(level, v, sp, u) {
    var cells = seFortCells(level, v, sp)
    if (cells.length < 5) return null
    var taken = []
    for (var k in SE_HIDE) if (k !== u && SE_HIDE[k]) taken.push(SE_HIDE[k])
    var best = null, bestD = -1
    for (var t = 0; t < 16; t++) {
        var c = cells[Math.floor(Math.random() * cells.length)]
        var d = 1e9
        taken.forEach(h => { var dd = Math.pow(h.x - c.x, 2) + Math.pow(h.z - c.z, 2); if (dd < d) d = dd })
        if (d >= 4) return c
        if (d > bestD) { bestD = d; best = c }
    }
    return best
}

/**
 * Бежать в форт: снаружи - к воротам (бегом), от ворот шагом во двор, а во дворе тихо
 * ходить от точки к точке, не ближе семи блоков к воротам. Высоту целей знаем точно
 * (ворота, двор): верх столба у ворот - это крыша надвратной башни.
 */
function seFortRun(e, v, speed) {
    var sp = seFortSpot(v)
    if (!sp) {
        seGo(e, v, v.x + (Math.random() - 0.5) * 6, v.z + (Math.random() - 0.5) * 6, speed)
        return
    }
    var u = String(e.uuid)
    var yard = seFortYard(e.level, sp)
    var m = SE_MOVE[u]
    var inYard = yard ? e.getX() >= yard.x1 && e.getX() <= yard.x2 + 1 && e.getZ() >= yard.z1 && e.getZ() <= yard.z2 + 1
        : Math.pow(e.getX() - sp.inside.x - 0.5, 2) + Math.pow(e.getZ() - sp.inside.z - 0.5, 2) < 25
    if (!yard) yard = { x1: sp.inside.x - 2, x2: sp.inside.x + 2, z1: sp.inside.z - 2, z2: sp.inside.z + 2 }
    // за воротами в стенах форта - уже свой: дальше идёт на своё место во дворе
    var bx0 = sp.box
    var inFort0 = bx0 && e.getX() >= bx0.x1 && e.getX() <= bx0.x2 + 1 && e.getZ() >= bx0.z1 && e.getZ() <= bx0.z2 + 1
    if (!inYard && inFort0) {
        var g2 = Math.pow(e.getX() - sp.gate.x - 0.5, 2) + Math.pow(e.getZ() - sp.gate.z - 0.5, 2)
        var i2 = Math.pow(e.getX() - sp.inside.x - 0.5, 2) + Math.pow(e.getZ() - sp.inside.z - 0.5, 2)
        var o2 = Math.pow(sp.gate.x - sp.inside.x, 2) + Math.pow(sp.gate.z - sp.inside.z, 2)
        if (g2 >= 9 && i2 < o2) inYard = true
    }
    if (!inYard) {
        delete SE_HIDE[u]
        var gdx = e.getX() - (sp.gate.x + 0.5), gdz = e.getZ() - (sp.gate.z + 0.5)
        // Уже за воротами, в стенах форта, но до двора не дошёл: только вглубь. Раньше в шаге
        // от ворот (дальше 4 блоков) его снова звали к воротам - толпа заходила и откатывалась к порогу.
        var bx = sp.box
        var inFort = bx && e.getX() >= bx.x1 && e.getX() <= bx.x2 + 1 && e.getZ() >= bx.z1 && e.getZ() <= bx.z2 + 1
        var gateD2 = gdx * gdx + gdz * gdz
        var inD2 = Math.pow(e.getX() - sp.inside.x - 0.5, 2) + Math.pow(e.getZ() - sp.inside.z - 0.5, 2)
        var outD2 = Math.pow(sp.gate.x + 0.5 - sp.inside.x - 0.5, 2) + Math.pow(sp.gate.z + 0.5 - sp.inside.z - 0.5, 2)
        if (inFort && gateD2 >= 1 && inD2 < outD2) {
            seMove(e, sp.inside.x + 0.5, sp.insideY !== null ? sp.insideY : sp.gate.y, sp.inside.z + 0.5, speed / 1.8)
            if (m) m.rescue = sp.insideY !== null ? { x: sp.inside.x, y: sp.insideY, z: sp.inside.z } : null
            return
        }
        if (gateD2 < 25 && seGateHop(e, v, sp)) return
        if (gateD2 < 16) {
            // в воротах: шагом внутрь, к середине двора
            // напрямую, без вех: ближайшая веха троп - снаружи, и маршрут уводил обратно за ворота
            seMove(e, sp.inside.x + 0.5, sp.insideY !== null ? sp.insideY : sp.gate.y, sp.inside.z + 0.5, speed / 1.8)
        } else {
            seGo(e, v, sp.gate.x + 0.5, sp.gate.z + 0.5, speed, sp.gate.y)
        }
        if (m) m.rescue = { x: sp.gate.x, y: sp.gate.y, z: sp.gate.z }
        return
    }
    var now = Number(e.level.getTime())
    var h = SE_HIDE[u]
    if (!h || now >= h.until) {
        var pick = seHideSpot(e.level, v, sp, u)
        for (var t = 0; t < 10 && !pick; t++) {
            var hx = yard.x1 + Math.random() * (yard.x2 - yard.x1 + 1)
            var hz = yard.z1 + Math.random() * (yard.z2 - yard.z1 + 1)
            if (Math.pow(hx - sp.gate.x, 2) + Math.pow(hz - sp.gate.z, 2) >= 49) pick = { x: hx, z: hz }
        }
        if (!pick) pick = { x: sp.inside.x + 0.5, z: sp.inside.z + 0.5 }
        h = SE_HIDE[u] = { x: pick.x, z: pick.z, until: now + 300 + Math.floor(Math.random() * 400) }
    }
    var dx = e.getX() - h.x, dz = e.getZ() - h.z
    // по двору - напрямую и шагом: вехи троп снаружи, через них житель вышел бы обратно
    if (dx * dx + dz * dz > 2.25) seMove(e, h.x, sp.insideY !== null ? sp.insideY : e.getY(), h.z, speed / 1.8 * 0.8)
    else { try { e.getNavigation().stop() } catch (err) { } }
    // застрянет во дворе - вытаскиваем на середину двора, а не к воротам
    if (m) m.rescue = sp.insideY !== null ? { x: sp.inside.x, y: sp.insideY, z: sp.inside.z } : null
}
// ─── Двор крепости: колокол, костёр, лавки ───────────────────────────────────
//
// Двор форта пустовал. Теперь там три места, и у каждого свой хозяин:
//   колокол на каменной площадке 3x3 - в него без остановки бьёт правитель во время осады;
//   костёр - у него вечером играет бард, а в тревогу его разжигают спрятавшиеся в крепости;
//   лавки - навесы на столбах со столом-прилавком; их на одну больше, чем торговцев.
//   Днём торговец стоит за своим прилавком, вечером уходит. Лишняя лавка - для караванов,
//   прибывающих в поселение (factions/fairs.js возьмёт её через global.TFG_FORT_YARD).
// Места ищутся по самому двору (seFortYard), мимо прохода от ворот. Строится один раз; после
// пересборки построек (restore) двор выглаживается заново - тогда и места ставятся заново.

const SE_YARD_VER = 2                // 2: костёр TFC, столы Macaw's, ровный двор, лавки и снаружи
const SE_ItemHandlerCap = Java.loadClass("net.minecraftforge.common.capabilities.ForgeCapabilities").ITEM_HANDLER

function seBlockId(level, x, y, z) { try { return String(level.getBlock(x, y, z).id) } catch (e) { return "" } }

/** Природное: земля, камень, трава, снег - такое можно срезать и подсыпать. */
function seNaturalId(id) {
    if (!id || id === "minecraft:air" || id === "minecraft:cave_air") return true
    return /(grass|dirt|tfc:plant|snow|sand|gravel|rock\/raw|rock\/loose|rock\/hardened|clay|mud|farmland|rooted)/.test(id) &&
        !/(planks|bricks|stairs|slab|fence|wall)/.test(id)
}

function seExists(id) {
    try { if (global.TFG_STRUCTURES.exists) return !!global.TFG_STRUCTURES.exists(id) } catch (e) { }
    try { var it = Item.of(id); return !!(it && !it.isEmpty()) } catch (e) { return false }
}

/**
 * Выровнять открытую землю двора на одну высоту. Двор после постройки форта лежит то на
 * блок выше, то ниже, и площадки 3x3 строго на одной высоте почти не находились - отсюда
 * одна лавка вместо трёх. Трогаем только столбы, где нет ничего рукотворного.
 */
function seYardFlatten(level, v, sp, yard) {
    var Y = sp.insideY, n = 0
    for (var x = yard.x1; x <= yard.x2; x++) {
        for (var z = yard.z1; z <= yard.z2; z++) {
            var clean = true
            for (var y = Y - 1; y <= Y + 6 && clean; y++) if (!seNaturalId(seBlockId(level, x, y, z))) clean = false
            if (!clean) continue
            var ground = seBlockId(level, x, Y - 1, z)
            if (ground === "minecraft:air" || ground.indexOf("tfc:plant") === 0) ground = "tfc:dirt/loam"
            if (ground.indexOf("grass") < 0 && ground.indexOf("dirt") < 0) ground = "tfc:grass/loam"
            seRun("execute in " + v.dim + " run fill " + x + " " + Y + " " + z + " " + x + " " + (Y + 4) + " " + z + " minecraft:air replace")
            seRun("execute in " + v.dim + " run fill " + x + " " + (Y - 3) + " " + z + " " + x + " " + (Y - 2) + " " + z + " tfc:dirt/loam keep")
            seRun("execute in " + v.dim + " run setblock " + x + " " + (Y - 1) + " " + z + " " + ground + " replace")
            n++
        }
    }
    return n
}

function seYardSquares(level, sp, yard) {
    var Y = sp.insideY
    var ok = (x, z) => seStandable(level, x, Y, z) && seOpenAt(level, x, Y + 2, z) && seOpenAt(level, x, Y + 3, z)
    // проход от ворот к середине двора не занимаем
    var gx = sp.gate.x + 0.5, gz = sp.gate.z + 0.5, cx = sp.inside.x + 0.5, cz = sp.inside.z + 0.5
    var corridor = (x, z) => {
        var vx = cx - gx, vz = cz - gz, l2 = vx * vx + vz * vz || 1
        var t = Math.max(0, Math.min(1, ((x + 0.5 - gx) * vx + (z + 0.5 - gz) * vz) / l2))
        var px = gx + vx * t - x - 0.5, pz = gz + vz * t - z - 0.5
        return px * px + pz * pz < 2.5 * 2.5
    }
    var out = []
    for (var x0 = yard.x1; x0 <= yard.x2 - 2; x0++) {
        for (var z0 = yard.z1; z0 <= yard.z2 - 2; z0++) {
            var good = true
            for (var i = 0; i < 3 && good; i++) for (var j = 0; j < 3 && good; j++) {
                if (corridor(x0 + i, z0 + j) || !ok(x0 + i, z0 + j)) good = false
            }
            if (good) out.push({ x: x0, z: z0, cx: x0 + 1, cz: z0 + 1, y: Y, d: Math.pow(x0 + 1 - sp.inside.x, 2) + Math.pow(z0 + 1 - sp.inside.z, 2) })
        }
    }
    return out
}

/**
 * Площадки 3x3 снаружи, вплотную к крепости: для лавок, что не влезли во двор. Ближе к стене -
 * раньше; не на тропах и крыльцах (протоптанная земля), не перед воротами, земля ровная или
 * с перепадом в блок - его выравниваем.
 */
function seYardOutside(level, v, sp, used) {
    var b = sp.box
    var gdx = sp.gate.x - sp.inside.x, gdz = sp.gate.z - sp.inside.z
    var gate = Math.abs(gdx) >= Math.abs(gdz) ? { dx: gdx > 0 ? 1 : -1, dz: 0 } : { dx: 0, dz: gdz > 0 ? 1 : -1 }
    var cand = []
    for (var x0 = b.x1 - 16; x0 <= b.x2 + 14; x0++) {
        for (var z0 = b.z1 - 16; z0 <= b.z2 + 14; z0++) {
            if (x0 + 2 >= b.x1 - 1 && x0 <= b.x2 + 1 && z0 + 2 >= b.z1 - 1 && z0 <= b.z2 + 1) continue
            var cx = x0 + 1, cz = z0 + 1
            var d = Math.max(b.x1 - cx, cx - b.x2, b.z1 - cz, cz - b.z2)
            if (d > 14) continue
            // перед воротами - дорога; там не строим
            var rx = cx - sp.gate.x, rz = cz - sp.gate.z
            var along = rx * gate.dx + rz * gate.dz, side = Math.abs(rx * gate.dz - rz * gate.dx)
            if (along > -2 && along < 18 && side < 6) continue
            cand.push({ x: x0, z: z0, cx: cx, cz: cz, d: d })
        }
    }
    cand.sort((a, c) => a.d - c.d)
    var height = (x, z) => { try { return Number(level.getHeight("MOTION_BLOCKING_NO_LEAVES", x, z)) } catch (e) { return null } }
    var fits = s => {
        for (var i = -1; i <= 3; i++) for (var j = -1; j <= 3; j++) if (used[(s.x + i) + "," + (s.z + j)]) return false
        var Y = height(s.cx, s.cz)
        if (Y === null) return false
        for (var i2 = 0; i2 < 3; i2++) for (var j2 = 0; j2 < 3; j2++) {
            var x = s.x + i2, z = s.z + j2
            var h = height(x, z)
            if (h === null || Math.abs(h - Y) > 1) return false
            var top = seBlockId(level, x, h - 1, z)
            if (!seNaturalId(top) || top.indexOf("grass_path") >= 0 || top.indexOf("water") >= 0) return false
            for (var y = Y; y <= Y + 4; y++) if (!seNaturalId(seBlockId(level, x, y, z))) return false
        }
        s.y = Y
        return true
    }
    return { next: () => { while (cand.length) { var s = cand.shift(); if (fits(s)) return s } return null } }
}

function seStallBuild(v, s, front, wood) {
    var run = c => seRun("execute in " + v.dim + " run " + c)
    var Y = s.y
    // площадка: выравниваем на одну высоту (снаружи земля бывает на блок выше или ниже)
    run("fill " + s.x + " " + Y + " " + s.z + " " + (s.x + 2) + " " + (Y + 4) + " " + (s.z + 2) + " minecraft:air replace")
    run("fill " + s.x + " " + (Y - 1) + " " + s.z + " " + (s.x + 2) + " " + (Y - 1) + " " + (s.z + 2) + " tfc:grass_path/loam replace")
    var post = "tfc:wood/planks/" + wood + "_fence"
    ;[[0, 0], [2, 0], [0, 2], [2, 2]].forEach(p => {
        run("fill " + (s.x + p[0]) + " " + Y + " " + (s.z + p[1]) + " " + (s.x + p[0]) + " " + (Y + 1) + " " + (s.z + p[1]) + " " + post + " replace")
    })
    run("fill " + s.x + " " + (Y + 2) + " " + s.z + " " + (s.x + 2) + " " + (Y + 2) + " " + (s.z + 2) +
        " tfc:wood/planks/" + wood + "_slab[type=bottom] replace")
    // прилавок - стол Macaw's из той же породы, середина передней стороны
    var table = "mcw_tfc_aio:furniture/" + wood + "_furniture/" + wood + "_table"
    if (!seExists(table)) table = "mcw_tfc_aio:furniture/oak_furniture/oak_table"
    var tx = s.cx + front.dx, tz = s.cz + front.dz
    run("setblock " + tx + " " + Y + " " + tz + " " + table + " replace")
    return { x: s.x, z: s.z, table: { x: tx, y: Y, z: tz }, stand: { x: s.cx, y: Y, z: s.cz }, front: front }
}

/**
 * Костёр без ровной площадки: ближайшая к середине двора клетка, где в квадрате 3x3 только
 * земля и воздух (не стены, не лавки), не ближе четырёх блоков к колоколу и семи к воротам.
 * Площадку расчищаем, мостим булыжником и ставим кострище. Возвращает { x, y, z } или null.
 */
function seYardForceFire(level, v, sp, yard, Y, rock, bell, used) {
    var run = c => seRun("execute in " + v.dim + " run " + c)
    var cells = []
    for (var x = yard.x1 + 1; x <= yard.x2 - 1; x++) {
        for (var z = yard.z1 + 1; z <= yard.z2 - 1; z++) {
            if (bell && Math.pow(x - bell.x, 2) + Math.pow(z - bell.z, 2) < 16) continue
            if (Math.pow(x - sp.gate.x, 2) + Math.pow(z - sp.gate.z, 2) < 49) continue
            cells.push({ x: x, z: z, d: Math.pow(x - sp.inside.x, 2) + Math.pow(z - sp.inside.z, 2) })
        }
    }
    cells.sort((a, b) => a.d - b.d)
    for (var i = 0; i < cells.length; i++) {
        var c = cells[i], ok = true
        for (var dx = -1; dx <= 1 && ok; dx++) for (var dz = -1; dz <= 1 && ok; dz++) {
            if (used && used[(c.x + dx) + "," + (c.z + dz)]) ok = false
            for (var y = Y; y <= Y + 3 && ok; y++) if (!seNaturalId(seBlockId(level, c.x + dx, y, c.z + dz))) ok = false
        }
        if (!ok) continue
        run("fill " + (c.x - 1) + " " + Y + " " + (c.z - 1) + " " + (c.x + 1) + " " + (Y + 3) + " " + (c.z + 1) + " minecraft:air replace")
        run("fill " + (c.x - 1) + " " + (Y - 1) + " " + (c.z - 1) + " " + (c.x + 1) + " " + (Y - 1) + " " + (c.z + 1) + " tfc:rock/cobble/" + rock + " replace")
        run("setblock " + c.x + " " + Y + " " + c.z + " tfc:firepit[lit=false] replace")
        if (used) for (var ux = -1; ux <= 1; ux++) for (var uz = -1; uz <= 1; uz++) used[(c.x + ux) + "," + (c.z + uz)] = 1
        seLog("поселение " + v.id + ": костёр двора поставлен силой у " + c.x + " " + c.z)
        return { x: c.x, y: Y, z: c.z }
    }
    seLog("поселение " + v.id + ": костру во дворе места нет вовсе")
    return null
}

/** Убрать прежнюю обстановку двора (при переделке мест). */
function seYardClear(v) {
    var y = v.yard
    if (!y) return
    var run = c => seRun("execute in " + v.dim + " run " + c)
    if (y.bell) run("setblock " + y.bell.x + " " + y.bell.y + " " + y.bell.z + " minecraft:air replace")
    if (y.fire) run("setblock " + y.fire.x + " " + y.fire.y + " " + y.fire.z + " minecraft:air replace")
    ;(y.stalls || []).forEach(s => {
        var sy = s.stand.y !== undefined ? s.stand.y : y.y
        run("fill " + (s.stand.x - 1) + " " + sy + " " + (s.stand.z - 1) + " " + (s.stand.x + 1) + " " + (sy + 2) + " " +
            (s.stand.z + 1) + " minecraft:air replace")
    })
}

function seYardBuild(level, v, sp, yard) {
    seYardClear(v)
    seYardFlatten(level, v, sp, yard)
    var Y = sp.insideY
    var squares = seYardSquares(level, sp, yard)
    var used = {}
    var free = s => {
        for (var i = -1; i <= 3; i++) for (var j = -1; j <= 3; j++) if (used[(s.x + i) + "," + (s.z + j)]) return false
        return true
    }
    var take = s => { for (var i = 0; i < 3; i++) for (var j = 0; j < 3; j++) used[(s.x + i) + "," + (s.z + j)] = 1 }
    var run = c => seRun("execute in " + v.dim + " run " + c)
    var st = seStreet(v) || {}
    var rock = st.stone || "granite"
    var wood = (st.woods && st.woods[0]) || "oak"
    var yd = { ver: SE_YARD_VER, y: Y, bell: null, fire: null, stalls: [], lit: false }

    // колокол - ближе всего к середине двора
    var byCenter = squares.slice().sort((a, b) => a.d - b.d)
    var bs = byCenter.filter(free)[0]
    if (bs) {
        take(bs)
        run("fill " + bs.x + " " + (Y - 1) + " " + bs.z + " " + (bs.x + 2) + " " + (Y - 1) + " " + (bs.z + 2) + " tfc:rock/bricks/" + rock + " replace")
        run("setblock " + bs.cx + " " + Y + " " + bs.cz + " tfc:bronze_bell[attachment=floor,facing=north] replace")
        yd.bell = { x: bs.cx, y: Y, z: bs.cz }
    }
    // костёр TFC (кострище) - не ближе пяти блоков к колоколу, тоже ближе к середине
    var fs = byCenter.filter(s => free(s) && (!yd.bell || Math.pow(s.cx - yd.bell.x, 2) + Math.pow(s.cz - yd.bell.z, 2) >= 25))[0]
    if (fs) {
        take(fs)
        run("fill " + fs.x + " " + (Y - 1) + " " + fs.z + " " + (fs.x + 2) + " " + (Y - 1) + " " + (fs.z + 2) + " tfc:rock/cobble/" + rock + " replace")
        run("setblock " + fs.cx + " " + Y + " " + fs.cz + " tfc:firepit[lit=false] replace")
        yd.fire = { x: fs.cx, y: Y, z: fs.cz }
    } else {
        // ровной площадки 3x3 не нашлось (двор кочковатый или тесный) - ставим силой
        yd.fire = seYardForceFire(level, v, sp, yard, Y, rock, yd.bell, used)
    }
    // лавки - у стен двора, на одну больше, чем торговцев; не влезли - снаружи у самой крепости
    var traders = v.settlers.filter(s => s.role === "торговец" && !s.dead && !s.replaced)
    var want = traders.length + 1
    var byWall = squares.slice().sort((a, b) => b.d - a.d)
    var inside = 0
    var addStall = (s, outside) => {
        take(s)
        var dx = outside ? s.cx - sp.inside.x : sp.inside.x - s.cx
        var dz = outside ? s.cz - sp.inside.z : sp.inside.z - s.cz
        // во дворе прилавок смотрит в середину двора, снаружи - прочь от стены, к людям
        var f = Math.abs(dx) >= Math.abs(dz) ? { dx: dx >= 0 ? 1 : -1, dz: 0 } : { dx: 0, dz: dz >= 0 ? 1 : -1 }
        var rec = traders[yd.stalls.length]
        var made = seStallBuild(v, s, f, wood)
        made.sid = rec ? rec.id : null
        made.caravan = !rec
        made.outside = !!outside
        yd.stalls.push(made)
    }
    for (var k = 0; k < byWall.length && yd.stalls.length < want; k++) {
        if (!free(byWall[k])) continue
        addStall(byWall[k], false)
        inside++
    }
    if (yd.stalls.length < want) {
        var outer = seYardOutside(level, v, sp, used)
        while (yd.stalls.length < want) {
            var s2 = outer.next()
            if (!s2) break
            addStall(s2, true)
        }
    }
    v.yard = yd
    seSave()
    seLog("поселение " + v.id + ": двор крепости - колокол " + (yd.bell ? "есть" : "НЕТ") + ", костёр " +
        (yd.fire ? "есть" : "НЕТ") + ", лавок " + yd.stalls.length + " из " + want + " (во дворе " + inside +
        ", снаружи " + (yd.stalls.length - inside) + ")")
}

/** Дрова в кострище: TFC гасит огонь без топлива, поэтому подкладываем, пока ему положено гореть. */
function seFireFuel(level, f) {
    try {
        var be = level.getBlock(f.x, f.y, f.z).getEntity()
        if (!be) return
        var cap = be.getCapability(SE_ItemHandlerCap).resolve()
        if (!cap.isPresent()) return
        var h = cap.get()
        for (var s = 0; s < 4 && s < h.getSlots(); s++) h.insertItem(s, Item.of("tfc:wood/log/oak", 4), false)
    } catch (e) { }
}

function seFireSet(level, f, lit) {
    try {
        var blk = level.getBlock(f.x, f.y, f.z)
        if (String(blk.id) !== "tfc:firepit") return
        var st = String(blk.getBlockState())
        var props = { lit: lit ? "true" : "false" }
        var ax = st.match(/axis=([xz])/)
        if (ax) props.axis = ax[1]
        blk.set("tfc:firepit", props)                  // set, а не setblock: дрова внутри уцелеют
    } catch (e) { seErr("кострище", e) }
}

/** Один раз поставить места во дворе; дальше - только огонь: горит вечером и в тревогу. */
function seYardTick(level, v) {
    if (!v.yard || v.yard.ver !== SE_YARD_VER) {
        if (!sePlayerNear(level, v, 160)) return
        try { if (global.TFG_STRUCTURES.busy() || global.TFG_STREET.busy()) return } catch (e) { }
        var sp = seFortSpot(v)
        if (!sp) return
        var yard = seFortYard(level, sp)
        if (!yard || sp.insideY === null) return
        seYardBuild(level, v, sp, yard)
        return
    }
    var y = v.yard
    // двор уже обставлен, а костра нет (раньше ставился только на ровной площадке) - один раз ставим силой
    if (!y.fire && !y.fireTried) {
        y.fireTried = true
        var fsp = seFortSpot(v)
        var fyard = fsp ? seFortYard(level, fsp) : null
        if (fyard && fsp.insideY !== null) {
            var fst = seStreet(v) || {}
            var used2 = {}
            ;(y.stalls || []).forEach(s => { for (var i = 0; i < 3; i++) for (var j = 0; j < 3; j++) used2[(s.x + i) + "," + (s.z + j)] = 1 })
            if (y.bell) used2[y.bell.x + "," + y.bell.z] = 1
            y.fire = seYardForceFire(level, v, fsp, fyard, y.y, fst.stone || "granite", y.bell, used2)
        }
        seSave()
    }
    if (!y.fire) return
    var t = Number(level.getDayTime()) % SE_DAY
    var alarm = v.state === "тревога" || v.state === "осада" || v.state === "вылазка"
    var evening = t >= SE_EVENING_FROM && !seIsNight(level)
    // и пока у костра идёт аудиенция (fairs.js): беседа ведётся у огня
    var want = alarm || evening || (y.meetUntil && Number(level.getTime()) < y.meetUntil)
    try { if (!level.hasChunk(y.fire.x >> 4, y.fire.z >> 4)) return } catch (e) { return }
    if (want) seFireFuel(level, y.fire)                 // дрова подкладываем, пока огню гореть
    if (want === !!y.lit) return
    y.lit = want
    seFireSet(level, y.fire, want)
    seSave()
}
/**
 * Идти к точке во дворе крепости. По двору - напрямую (вехи троп снаружи и увели бы за
 * ворота), снаружи - к воротам по тропам, от ворот - во двор.
 */
/**
 * Застрял в самих воротах (секунды три ни с места) - переносим на четыре шага внутрь, во
 * двор, если никто из игроков этого не видит. Ворота у всех фортов разные, и где-то проём
 * для навигации тесен: тогда жители толклись у ворот и не заходили.
 */
function seGateHop(e, v, sp) {
    var m = SE_MOVE[String(e.uuid)]
    if (!m || (m.fails || 0) < 2 || sp.insideY === null) return false
    var gx = sp.inside.x - sp.gate.x, gz = sp.inside.z - sp.gate.z
    var din = Math.abs(gx) >= Math.abs(gz) ? { dx: gx > 0 ? 1 : -1, dz: 0 } : { dx: 0, dz: gz > 0 ? 1 : -1 }
    var tx = sp.gate.x + din.dx * 4, tz = sp.gate.z + din.dz * 4
    var ty = null
    ;[0, 1, -1].forEach(dy => { if (ty === null && seStandable(e.level, tx, sp.insideY + dy, tz)) ty = sp.insideY + dy })
    if (ty === null || seSeenByPlayer(e.level, e)) return false
    seRun("execute in " + v.dim + " run tp " + String(e.uuid) + " " + (tx + 0.5) + " " + ty + " " + (tz + 0.5))
    m.fails = 0; m.outs = 0; m.detour = null
    SE_ROUTE[String(e.uuid)] = null
    return true
}

function seGoFort(e, v, x, z, speed) {
    var sp = seFortSpot(v)
    var yard = sp ? seFortYard(e.level, sp) : null
    if (!yard || sp.insideY === null) { seGo(e, v, x, z, speed); return }
    var inYard = e.getX() >= yard.x1 && e.getX() <= yard.x2 + 1 && e.getZ() >= yard.z1 && e.getZ() <= yard.z2 + 1
    var m = SE_MOVE[String(e.uuid)]
    if (inYard) {
        seMove(e, x, sp.insideY, z, speed)
        if (m) m.rescue = { x: sp.inside.x, y: sp.insideY, z: sp.inside.z }
        return
    }
    var gdx = e.getX() - (sp.gate.x + 0.5), gdz = e.getZ() - (sp.gate.z + 0.5)
    if (gdx * gdx + gdz * gdz < 25 && seGateHop(e, v, sp)) return
    if (gdx * gdx + gdz * gdz < 16) seMove(e, sp.inside.x + 0.5, sp.insideY, sp.inside.z + 0.5, speed)
    else seGo(e, v, sp.gate.x + 0.5, sp.gate.z + 0.5, speed, sp.gate.y)
    if (m) m.rescue = { x: sp.gate.x, y: sp.gate.y, z: sp.gate.z }
}

/** Правитель в осаду: у колокола и бьёт в него без остановки. */
function seBellTick(level, v, e, speed) {
    var b = v.yard.bell
    var sx = b.x + 1.5, sz = b.z + 0.5                           // рядом с колоколом, на площадке
    var dx = e.getX() - sx, dz = e.getZ() - sz
    if (dx * dx + dz * dz > 2.25) { seGoFort(e, v, sx, sz, speed); return }
    try { e.getNavigation().stop() } catch (err) { }
    try { e.getLookControl().setLookAt(b.x + 0.5, b.y + 0.5, b.z + 0.5) } catch (err) { }
    try { e.swing(SE_MAIN_HAND) } catch (err) { }
    var rang = false
    try {
        var blk = level.getBlock(b.x, b.y, b.z)
        var bell = blk.getBlockState().getBlock()
        var Dir = Java.loadClass("net.minecraft.core.Direction")
        if (typeof bell.attemptToRing === "function") rang = !!bell.attemptToRing(level, blk.getPos(), Dir.EAST)
        else if (typeof bell.m_49712_ === "function") rang = !!bell.m_49712_(level, blk.getPos(), Dir.EAST)
    } catch (err) { }
    if (!rang) seRun("execute in " + v.dim + " run playsound minecraft:block.bell.use block @a[distance=..96] " +
        b.x + " " + b.y + " " + b.z + " 2 1")
}

/** Торговец днём: за своим прилавком, лицом к покупателям. */
function seStallOf(v, e) {
    if (!v.yard || !v.yard.stalls) return null
    var sid = seSidOf(e)
    return v.yard.stalls.filter(s => s.sid === sid)[0] || null
}

function seStallTick(level, v, e, stall, speed) {
    var sx = stall.stand.x + 0.5, sz = stall.stand.z + 0.5
    var dx = e.getX() - sx, dz = e.getZ() - sz
    if (dx * dx + dz * dz > 1) {
        // лавка снаружи у стены - обычной дорогой; во дворе - через ворота
        if (stall.outside) seGo(e, v, sx, sz, speed, stall.stand.y)
        else seGoFort(e, v, sx, sz, speed)
        return
    }
    try { e.getNavigation().stop() } catch (err) { }
    try { e.getLookControl().setLookAt(sx + stall.front.dx * 4, e.getEyeY(), sz + stall.front.dz * 4) } catch (err) { }
    if (Math.random() < 0.01) seSay(v, "торг", e.getX(), e.getY(), e.getZ())
}

global.TFG_FORT_YARD = {
    // двор крепости поселения: { bell, fire, stalls: [{ table, stand, front, sid, caravan }] } или null
    of: vid => { try { return seLoad().villages[vid].yard || null } catch (e) { return null } },
    // свободная лавка для каравана
    caravanStall: vid => {
        try { return (seLoad().villages[vid].yard.stalls || []).filter(s => s.caravan)[0] || null } catch (e) { return null }
    },
}

function seBedOf(v, e) {
    var sid = seSidOf(e)
    var s = v.settlers.filter(x => x.id === sid)[0]
    return s ? s.bed : null
}

var SE_WANDER = {}

/**
 * Прогулка. Цель выбирается не куда попало, а по вехам троп - так житель идёт улицей,
 * а не пытается пройти сквозь дом. Новая цель берётся, когда пришёл или простоял впустую.
 */
function seWander(e, v, radius, speed) {
    var u = String(e.uuid)
    var w = SE_WANDER[u]
    var now = Number(e.level.getTime())
    if (w && now - w.at < 200) {
        seGo(e, v, w.x, w.z, speed)
        return
    }
    var x, z
    var nodes = v.graph && v.graph.nodes
    if (nodes && nodes.length) {
        // выбираем веху в пределах круга: пусть ходят по своим же тропам
        var tries = 0, pick = null
        while (tries++ < 20) {
            var n = nodes[Math.floor(Math.random() * nodes.length)]
            var dx = n[0] - v.x, dz = n[2] - v.z
            if (dx * dx + dz * dz > radius * radius) continue
            pick = n
            break
        }
        if (pick) { x = pick[0] + 0.5; z = pick[2] + 0.5 }
    }
    if (x === undefined) {
        var a = Math.random() * 6.283185307179586
        var r = Math.sqrt(Math.random()) * radius
        x = v.x + Math.cos(a) * r
        z = v.z + Math.sin(a) * r
    }
    SE_WANDER[u] = { at: now, x: x, z: z }
    seGo(e, v, x, z, speed)
}


// ─── Мирная жизнь: распорядок гостей плюс своя работа ────────────────────────

/**
 * Гости (factions/guests.js) уже умеют жить: ищут по округе стулья, очаги и берега,
 * садятся, греются, едят, ловят рыбу и разговаривают - с озвучкой и репликой над
 * головой. Городить второе такое хозяйство незачем: поселение прикидывается визитом
 * гостей (то же поле center, тот же список guards), и житель живёт их же машиной
 * занятий. Своё у жителей только ремесло: поле, лес, охота, песня.
 */
var SE_VIEW = {}

function seView(level, v, ents) {
    var gv = SE_VIEW[v.id]
    if (!gv) {
        var y = 70
        try { y = Number(level.getHeight("WORLD_SURFACE_WG", v.x, v.z)) } catch (e) { }
        gv = SE_VIEW[v.id] = { id: "village_" + v.id, dim: v.dim, faction: v.faction, guards: [],
            center: { x: v.x, y: y, z: v.z }, hostile: null }
    }
    if (ents) gv.guards = ents.map(e => String(e.uuid))
    return gv
}

/** Шаг поиска мест вокруг поселения - тот же, что у гостей. Раз в тик, не чаще. */
function seScan(level, v, ents) {
    if (typeof gsScanStep !== "function") return
    try { gsScanStep(seView(level, v, ents), level) } catch (e) { seErr("поиск мест", e) }
}

/**
 * Чем житель займётся на отдыхе. У гостей своя развесовка: «разговор» весит 6 и держит
 * двоих на месте до трёх минут, «посидеть» - до трёх минут, и поселение со стороны
 * выглядит вымершим. Поэтому занятие выбираем сами, а исполняет его машина гостей.
 */
function seLifeAct(gv, level, e, rt, now, night) {
    var pois = rt.pois || { chairs: [], fires: [], waters: [] }
    var opts = [["wander", 8], ["eat", 1]]
    if (pois.chairs && pois.chairs.length) opts.push(["sit", night ? 3 : 2])
    if (pois.fires && pois.fires.length) opts.push(["warm", night ? 4 : 1])
    if (pois.waters && pois.waters.length) opts.push(["fish", night ? 0 : 2])
    // разговор - редкость: двое встали, поговорили и разошлись
    if (Math.random() < 0.12) opts.push(["talk", 4])
    var total = 0
    opts.forEach(o => { total += o[1] })
    var roll = Math.random() * total, pick = opts[0][0]
    for (var i = 0; i < opts.length; i++) {
        roll -= opts[i][1]
        if (roll <= 0) { pick = opts[i][0]; break }
    }
    var made = null
    try { made = gsMakeAct(gv, level, e, rt, now, pick) } catch (err) { }
    if (!made || !made.act) {
        try { made = gsMakeAct(gv, level, e, rt, now, "wander") } catch (err) { }
    }
    var act = made && made.act
    if (act && act.dur) act.dur = Math.min(act.dur, 500)     // стоять дольше полминуты незачем
    if (act && act.until) act.until = now + 700
    return act
}

/** Отдать жителя машине занятий гостей: сидеть, греться, есть, удить, беседовать. */
function seLife(level, v, e, ents) {
    // если гостей в сборке нет, житель хотя бы гуляет по тропам, а не стоит столбом
    if (typeof gsActTick !== "function") {
        seWander(e, v, (v.ring || 28) + 24, 1)
        return false
    }
    var gv = seView(level, v, ents)
    var now = Number(level.getTime())
    try {
        var rt = gsRt(gv.id)
        var key = String(e.uuid)
        var cur = rt.acts[key]
        // занятие выбираем сами - и только когда прежнее кончилось
        if (!cur || now >= cur.until) {
            if (cur && typeof gsFinishAct === "function") { try { gsFinishAct(e, cur) } catch (err2) { } }
            var act = seLifeAct(gv, level, e, rt, now, seIsNight(level))
            if (act) rt.acts[key] = act
            else delete rt.acts[key]
        }
        gsActTick(gv, level, e, rt, now)
        gsStuckCheck(e, now)
    } catch (err) {
        seErr("жизнь", err)
        seWander(e, v, (v.ring || 28) + 24, 1)
        return false
    }
    return true
}

/** Бросить занятие гостей: перед своей работой надо встать со стула и убрать снедь. */
function seDropLife(v, e) {
    if (typeof gsFinishAct !== "function") return
    try {
        var rt = gsRt("village_" + v.id)
        var u = String(e.uuid)
        if (rt.acts[u]) { gsFinishAct(e, rt.acts[u]); delete rt.acts[u] }
    } catch (err) { }
}

// ─── Места работы: грядки и лес ──────────────────────────────────────────────

var SE_RELIT = {}                    // id поселения -> когда в последний раз пересвечивали
const SE_RELIGHT_EVERY = 2400        // раз в две минуты (сам огонь стережёт запрещатор в structures.js)

/**
 * Пересветка. Фонарь TFC гаснет навсегда, если в момент случайного тика бак пуст,
 * а пустым он может оказаться по тысяче причин: чужой мод, откат зоны, чей-то ковш.
 * Поэтому поселение чинит свой свет само, пока рядом есть игрок: проходит по
 * постройкам и тропам и заправляет каждый найденный фонарь заново.
 */
function seRelight(level, v) {
    var now = Number(level.getTime())
    if (now - (SE_RELIT[v.id] || 0) < SE_RELIGHT_EVERY) return
    if (!sePlayerNear(level, v, 128)) return
    SE_RELIT[v.id] = now
    try {
        var st = seStreet(v)
        if (st) global.TFG_STREET.light(level, st)
    } catch (e) { seErr("пересветка", e) }
}

var SE_SPOTS = {}                    // id поселения -> { fields, trees, i, at, done }
const SE_SPOT_R = 64                 // в таком круге от середины ищем работу
const SE_SPOT_PER_TICK = 200         // столько столбов просматриваем за тик

function seSpots(level, v) {
    var now = Number(level.getTime())
    var sp = SE_SPOTS[v.id]
    if (!sp || now - sp.at > 24000) sp = SE_SPOTS[v.id] = { fields: [], trees: [], industry: [], water: [], i: 0, at: now, done: false }
    if (sp.done) return sp
    var side = Math.floor(SE_SPOT_R * 2 / 2) + 1
    var n = 0
    while (sp.i < side * side && n < SE_SPOT_PER_TICK) {
        var ix = sp.i % side, iz = Math.floor(sp.i / side)
        sp.i++
        n++
        var x = v.x - SE_SPOT_R + ix * 2, z = v.z - SE_SPOT_R + iz * 2
        var y = 0
        try { y = Number(level.getHeight("WORLD_SURFACE_WG", x, z)) } catch (e) { continue }
        var under = "", top = ""
        try {
            under = String(level.getBlock(x, y - 1, z).id)
            top = String(level.getBlock(x, y, z).id)
        } catch (e) { continue }
        // Грядка: над пашней стоит посев, и высота столба считается по нему,
        // поэтому смотреть надо оба блока.
        if (under.indexOf("farmland") >= 0 || under.indexOf("tfc:crop/") === 0 ||
            top.indexOf("tfc:crop/") === 0 || top.indexOf("farmland") >= 0) {
            if (sp.fields.length < 120) sp.fields.push([x, y, z])
        } else if (under.indexOf("wood/log/") >= 0 || under.indexOf("wood/leaves/") >= 0) {
            if (sp.trees.length < 80) sp.trees.push([x, y, z])
        } else if (SE_INDUSTRY.test(under) || SE_INDUSTRY.test(top)) {
            // промзона: станки, наковальни, печи, бочки - встаём рядом и работаем
            if (sp.industry.length < 40) sp.industry.push([x, y, z])
        } else if ((under === "minecraft:water" || top === "minecraft:water") && sp.water.length < 40) {
            // рыбалка: открытая вода в округе (рыбачат с берега, у края воды)
            sp.water.push([x, y, z])
        }
    }
    if (sp.i >= side * side) {
        sp.done = true
        seLog("поселение " + v.id + ": грядок " + sp.fields.length + ", деревьев " + sp.trees.length +
            ", промзона " + sp.industry.length + ", вода " + sp.water.length)
    }
    return sp
}

function seNearSpot(list, e) {
    var best = null, bestD = 1e9
    for (var i = 0; i < list.length; i++) {
        var p = list[i]
        var dx = p[0] - e.getX(), dz = p[2] - e.getZ()
        var d = dx * dx + dz * dz
        if (d < bestD) { bestD = d; best = p }
    }
    return best
}

// ─── Работа по ролям ─────────────────────────────────────────────────────────

var SE_JOB = {}                      // uuid -> { id, x, y, z, until, stage, hand, ... }

const SE_HOE = ["tfc:metal/hoe/bronze", "tfc:metal/hoe/copper", "minecraft:stone_hoe"]
const SE_AXE = ["tfc:metal/axe/bronze", "tfc:metal/axe/copper", "minecraft:stone_axe"]

function seTool(list) {
    for (var i = 0; i < list.length; i++) {
        try { if (global.TFG_STRUCTURES.exists(list[i])) return list[i] } catch (e) { }
    }
    return list[list.length - 1]
}

/** Взять в руку орудие, запомнив, что было. */
// Что было в руке, запоминаем целым предметом, а не одним id: ствол TACZ, возвращённый
// как Item.of("tacz:modern_kinetic_gun"), терял GunId и становился пустышкой без текстуры.
function seHold(e, j, item) {
    try {
        if (j.hand === undefined) {
            j.hand = String(e.getMainHandItem().id)
            j.handStack = e.getMainHandItem().copy()
        }
        e.setMainHandItem(Item.of(item))
    } catch (err) { }
}

function seUnhold(e, j) {
    if (!j || j.hand === undefined) return
    try {
        if (j.handStack) e.setMainHandItem(j.handStack)
        else e.setMainHandItem(j.hand === "minecraft:air" ? Item.of("minecraft:air") : Item.of(j.hand))
    } catch (err) { }
    j.hand = undefined
    j.handStack = undefined
}

/** Звери, на которых ходит охотник: всё дикое мясо сборки. */
const SE_GAME = ["tfc:deer", "tfc:caribou", "tfc:boar", "tfc:rabbit", "tfc:hare", "tfc:pheasant", "tfc:grouse",
    "tfc:turkey", "tfc:quail", "tfc:peafowl", "tfc:gazelle", "tfc:bongo", "tfc:wildebeest", "tfc:moose",
    "tfc:chicken", "tfc:duck", "tfc:sheep", "tfc:pig", "tfc:cow", "tfc:goat"]

function seGame(level, e, r) {
    var best = null, bestD = r * r
    try {
        var list = level.getEntities()
        for (var i = 0; i < list.size(); i++) {
            var a = list.get(i)
            if (!a || !a.isAlive()) continue
            if (SE_GAME.indexOf(String(a.type)) < 0) continue
            var dx = a.getX() - e.getX(), dz = a.getZ() - e.getZ()
            var d = dx * dx + dz * dz
            if (d < bestD) { bestD = d; best = a }
        }
    } catch (err) { }
    return best
}

/** Куда охотнику идти выслеживать: точка в лесу/поле за поселением, не в постройке и не в воде. */
function seTrackPoint(level, v) {
    for (var t = 0; t < 20; t++) {
        var r = 70 + Math.random() * 80, a = Math.random() * 6.283185307179586
        var x = Math.floor(v.x + Math.cos(a) * r), z = Math.floor(v.z + Math.sin(a) * r)
        try { if (!level.hasChunk(x >> 4, z >> 4)) continue } catch (err) { continue }
        var y = 0
        try { y = Number(level.getHeight("MOTION_BLOCKING_NO_LEAVES", x, z)) } catch (err) { continue }
        var under = seIdAt(level, x, y - 1, z)
        if (/water|lava|ice/.test(under)) continue
        if (seInBuiltZone(String(level.getDimension()), x, y, z)) continue
        return { x: x, y: y, z: z }
    }
    return null
}

/** Выбрать работу по роли. null - работы нет, пусть живёт распорядком гостей. */
// что считается промзоной: станки Create и GregTech, наковальни, печи и прочее оборудование
const SE_INDUSTRY = /^(create|createaddition|gtceu|vintageimprovements|greate):|anvil|bloomery|blast_furnace|forge|crucible|quern|barrel|charcoal_forge|firmalife:(oven|vat)|tfc:(pot|grill)/

function seMakeJob(level, v, e, role, now) {
    var sp = SE_SPOTS[v.id]
    if (role === "крестьянин" && sp) {
        // Крестьянин всегда при деле: грядки, промзона или рыбалка. Выбор с перевесом
        // в пользу грядок, но не все разом - иначе вся деревня толпится на одном огороде.
        var kinds = []
        if (sp.fields.length) kinds.push("поле", "поле", "поле")
        if (sp.industry.length) kinds.push("промзона", "промзона")
        if (sp.water.length) kinds.push("рыбалка")
        var kind = kinds.length ? sePick(kinds) : null
        if (kind === "поле") {
            var f = seNearSpot(sp.fields, e)
            if (f) return { id: "поле", x: f[0], y: f[1], z: f[2], until: now + 900, stage: "идти" }
        }
        if (kind === "промзона") {
            var m = sePick(sp.industry)
            return { id: "промзона", x: m[0], y: m[1], z: m[2], until: now + 1200, stage: "идти" }
        }
        if (kind === "рыбалка") {
            var w = seNearSpot(sp.water, e) || sePick(sp.water)
            var shore = seShore(level, w[0], w[2])
            if (shore) return { id: "рыбалка", x: shore.x, y: shore.y, z: shore.z, wx: w[0], wy: w[1], wz: w[2],
                until: now + 1800, stage: "идти" }
        }
    }
    if (role === "лесоруб") {
        // только природное дерево: ближайшее из найденных у поселения, а нет - ищем дальше
        var tree = null
        if (sp && sp.trees.length) {
            var cand = sp.trees.slice().sort((a, b) => Math.pow(a[0] - e.getX(), 2) + Math.pow(a[2] - e.getZ(), 2) -
                Math.pow(b[0] - e.getX(), 2) - Math.pow(b[2] - e.getZ(), 2)).slice(0, 8)
            for (var ti = 0; ti < cand.length && !tree; ti++) tree = seNaturalTree(level, cand[ti][0], cand[ti][1], cand[ti][2])
        }
        if (!tree) tree = seFindTree(level, v, e, SE_TREE_FAR)
        if (tree) return { id: "лес", x: tree.x, y: tree.y, z: tree.z, until: now + 3600, stage: "идти", chops: 0 }
    }
    if (role === "охотник") {
        var g = seGame(level, e, SE_HUNT_FAR)
        if (g) return { id: "охота", target: g, x: g.getX(), y: g.getY(), z: g.getZ(), until: now + 3600, stage: "идти" }
        // зверя поблизости не видно - уходит в лес выслеживать
        var tp = seTrackPoint(level, v)
        if (tp) return { id: "следы", x: tp.x, y: tp.y, z: tp.z, until: now + 2400, legs: 0 }
    }
    if (role === "бард") return null                  // песня - только вечером на улице (seBardPerform)
    return null
}

/**
 * Работа руками. Дойти до места, встать и делать дело: крестьянин тяпает грядку,
 * лесоруб валит дерево и тут же сажает саженец, охотник гонит зверя, бард играет.
 */
function seJobTick(level, v, e, j, now, role, speed) {
    if (j.id === "следы") {
        // по пути и на месте высматривает зверя: заметил - охота
        if (now % 40 < SE_TICK) {
            var seen = seGame(level, e, 48)
            if (seen) {
                SE_JOB[String(e.uuid)] = { id: "охота", target: seen, x: seen.getX(), y: seen.getY(), z: seen.getZ(), until: now + 3600, stage: "идти" }
                return
            }
        }
        var sdx = e.getX() - j.x, sdz = e.getZ() - j.z
        if (sdx * sdx + sdz * sdz > 16) { seGoFar(e, v, j.x, j.z, speed); return }
        // дошёл, следов нет - к следующей точке (не больше четырёх переходов)
        var np = j.legs < 3 ? seTrackPoint(level, v) : null
        if (np) { j.x = np.x; j.y = np.y; j.z = np.z; j.legs++ }
        else j.until = now
        return
    }
    if (j.id === "охота") {
        var g = j.target
        if (!g || !g.isAlive()) {
            // зверь добыт: подойти к туше и подобрать добычу
            if (!j.took) { j.took = true; j.until = now + 400; j.x = j.lastX || j.x; j.z = j.lastZ || j.z }
            if (now >= j.until) return
            var tdx = e.getX() - j.x, tdz = e.getZ() - j.z
            if (tdx * tdx + tdz * tdz > 6.25) { seGoFar(e, v, j.x, j.z, speed); return }
            if (!j.looted) { j.looted = true; seCollect(v, j.x, e.getY(), j.z, 4) }
            if (now % 40 < SE_TICK) { try { e.swing(SE_MAIN_HAND) } catch (err) { } }
            j.until = Math.min(j.until, now + 60)
            return
        }
        j.lastX = g.getX()
        j.lastZ = g.getZ()
        // лук в деле: та же боевая голова, что у рейдеров - держит дистанцию и стреляет
        var hdx = e.getX() - g.getX(), hdz = e.getZ() - g.getZ()
        if (hdx * hdx + hdz * hdz > 40 * 40) { seGoFar(e, v, g.getX(), g.getZ(), speed * 1.3); return }
        if (!seFight(e, g)) seGoFar(e, v, g.getX(), g.getZ(), speed * 1.5)
        return
    }
    var dx = e.getX() - j.x, dz = e.getZ() - j.z
    if (dx * dx + dz * dz > 6.25) {
        if (j.id === "лес") seGoFar(e, v, j.x, j.z, speed)
        else seGo(e, v, j.x, j.z, speed)
        return
    }
    try { e.getNavigation().stop() } catch (err) { }
    try { e.getLookControl().setLookAt(j.x, j.y, j.z) } catch (err) { }

    if (j.id === "поле") {
        seHold(e, j, seTool(SE_HOE))
        // Настоящая работа: спелое убирается, освободившаяся грядка засевается заново.
        // Если нынче для посева холодно (зима), грядка остаётся пустой до тепла.
        var ripe = seRipe(level, j)
        if (ripe) {
            try { e.swing(SE_MAIN_HAND) } catch (err) { }
            try { e.getLookControl().setLookAt(ripe.x, ripe.y, ripe.z) } catch (err) { }
            seHarvest(level, v, ripe)
            j.done = (j.done || 0) + 1
            j.until = now + 200                              // есть что убирать - работаем дальше
            return
        }
        if (now % 40 < SE_TICK) {
            try { e.swing(SE_MAIN_HAND) } catch (err) { }
            seRun("execute in " + v.dim + " run playsound minecraft:item.hoe.till block @a " +
                j.x + " " + j.y + " " + j.z + " 0.6 1")
        }
        return
    }
    if (j.id === "лес") {
        seHold(e, j, seTool(SE_AXE))
        if (now % 40 < SE_TICK) {
            try { e.swing(SE_MAIN_HAND) } catch (err) { }
            seRun("execute in " + v.dim + " run playsound minecraft:entity.player.attack.sweep player @a " +
                j.x + " " + j.y + " " + j.z + " 0.5 1")
        }
        // Три удара по пять секунд - и дерево валится целиком. Потом лесоруб собирает
        // брёвна и сажает саженец на месте пня: лес вокруг должен остаться лесом.
        if (!j.started) j.started = now
        if (j.chops < 3 && now - j.started > 100 + j.chops * 100) {
            j.chops++
            if (j.chops >= 3) {
                var felled = seFell(level, v, j)
                j.felledAt = now
                j.until = now + (felled ? 160 : 40)
            }
        }
        if (j.felledAt && !j.collected && now - j.felledAt > 60) {
            j.collected = true
            seCollect(v, j.x, j.y, j.z, 10)                   // брёвна - в мешок
            seReplant(level, v, j)
        }
        return
    }
    if (j.id === "песня") {
        seTune(level, v, e)
        return
    }
    if (j.id === "промзона") {
        // у станка: молот в руке, мерные удары со звуком наковальни
        seHold(e, j, seTool(SE_HAMMER))
        if (now % 60 < SE_TICK) {
            try { e.swing(SE_MAIN_HAND) } catch (err) { }
            seRun("execute in " + v.dim + " run playsound minecraft:block.anvil.use block @a " +
                j.x + " " + j.y + " " + j.z + " 0.35 " + (0.9 + Math.random() * 0.3).toFixed(2))
        }
        return
    }
    if (j.id === "рыбалка") {
        // с берега: удочка в руке, взгляд на воду, изредка подсекает
        seHold(e, j, seTool(SE_ROD))
        try { e.getLookControl().setLookAt(j.wx + 0.5, j.wy, j.wz + 0.5) } catch (err) { }
        if (now % 200 < SE_TICK) {
            try { e.swing(SE_MAIN_HAND) } catch (err) { }
            seRun("execute in " + v.dim + " run playsound minecraft:entity.fishing_bobber.splash neutral @a " +
                j.x + " " + j.y + " " + j.z + " 0.4 1")
        }
        return
    }
}

/** Берег у воды: ближайший сухой столб с полом, куда можно встать. */
function seShore(level, wx, wz) {
    for (var r = 1; r <= 4; r++) {
        for (var dx = -r; dx <= r; dx++) {
            for (var dz = -r; dz <= r; dz++) {
                if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue
                var x = wx + dx, z = wz + dz, y = 0
                try { y = Number(level.getHeight("WORLD_SURFACE_WG", x, z)) } catch (e) { continue }
                var under = ""
                try { under = String(level.getBlock(x, y - 1, z).id) } catch (e) { continue }
                if (under.indexOf("water") >= 0 || under.indexOf("ice") >= 0) continue
                if (seOpenAt(level, x, y, z) && seOpenAt(level, x, y + 1, z)) return { x: x, y: y, z: z }
            }
        }
    }
    return null
}

const SE_HAMMER = ["tfc:metal/hammer/bronze", "tfc:metal/hammer/copper", "minecraft:stone_axe"]
const SE_ROD = ["tfc:metal/fishing_rod/bronze", "tfc:metal/fishing_rod/copper", "minecraft:fishing_rod"]

var SE_Climate = null

/** Нынешняя температура в точке - по ней решаем, можно ли сейчас сеять. */
function seTempNow(level, x, z) {
    try {
        if (!SE_Climate) SE_Climate = Java.loadClass("net.dries007.tfc.util.climate.Climate")
        var BlockPos = Java.loadClass("net.minecraft.core.BlockPos")
        return Number(SE_Climate.getTemperature(level, new BlockPos(Math.round(x), 70, Math.round(z))))
    } catch (e) { return 12 }
}

/** Спелый посев рядом с местом работы: {x, y, z, crop} или null. */
function seRipe(level, j) {
    for (var dx = -3; dx <= 3; dx++) {
        for (var dz = -3; dz <= 3; dz++) {
            var x = j.x + dx, z = j.z + dz
            for (var dy = -1; dy <= 1; dy++) {
                var st = ""
                try { st = String(level.getBlock(x, j.y + dy, z).getBlockState()) } catch (e) { continue }
                var m = st.match(/^Block\{tfc:crop\/([a-z_]+)\}.*age=(\d+)/)
                if (!m) continue
                var max = 7
                try { if (typeof DC_CROP_AGE !== "undefined" && DC_CROP_AGE[m[1]] !== undefined) max = DC_CROP_AGE[m[1]] } catch (e) { }
                if (Number(m[2]) < max) continue
                return { x: x, y: j.y + dy, z: z, crop: m[1] }
            }
        }
    }
    return null
}

/**
 * Убрать спелое и тут же засеять. Сеем то, что здесь растёт: список даёт factions/decor.js
 * по средней температуре и влаге, а нынешнюю температуру проверяем отдельно -
 * в мороз крестьянин землю не трогает, грядка ждёт тепла.
 */
function seHarvest(level, v, ripe) {
    seRun("execute in " + v.dim + " run setblock " + ripe.x + " " + ripe.y + " " + ripe.z + " minecraft:air destroy")
    seRun("execute in " + v.dim + " run playsound minecraft:block.crop.break block @a " +
        ripe.x + " " + ripe.y + " " + ripe.z + " 0.7 1")

    var list = []
    try { if (typeof dcCrops === "function") list = dcCrops(level, ripe.x, ripe.z) } catch (e) { }
    var crop = null
    if (list.length) crop = list.indexOf(ripe.crop) >= 0 ? ripe.crop : list[Math.floor(Math.random() * list.length)]
    else crop = ripe.crop
    var range = null
    try { if (typeof DC_CROP_RANGE !== "undefined") range = DC_CROP_RANGE[crop] } catch (e) { }
    var t = seTempNow(level, ripe.x, ripe.z)
    if (range && (t < range[0] + 2 || t > range[1] - 2)) return        // не сезон - грядка пустует
    seRun("execute in " + v.dim + " run setblock " + ripe.x + " " + ripe.y + " " + ripe.z +
        " tfc:crop/" + crop + "[age=0] replace")
    seRun("execute in " + v.dim + " run playsound minecraft:item.crop.plant block @a " +
        ripe.x + " " + ripe.y + " " + ripe.z + " 0.7 1")
}

/** Свалить одно бревно рядом и посадить саженец той же породы. */
// ─── Лесоруб и охотник: далёкая цель ─────────────────────────────────────────

const SE_TREE_FAR = 140              // так далеко от поселения лесоруб ищет дерево, если рядом нет
const SE_HUNT_FAR = 160              // и охотник - зверя
const SE_FELL_MAX = 600              // столько брёвен самое большее в одном дереве (секвойя-исполин)
const SE_LOG_RE = /^tfc:wood\/(log|wood)\/[a-z_]+$/
const SE_MANMADE_RE = /(planks|stairs|slab|fence|door|glass|bricks|stripped|wool|carpet|lamp|chest|barrel|torch|thatch|createdeco|mcw)/

function seIdAt(level, x, y, z) { try { return String(level.getBlock(x, y, z).id) } catch (e) { return "" } }

/** Точка внутри зоны постройки или поселения (кроме полей троп и выглаженной земли)? */
function seInBuiltZone(dim, x, y, z) {
    try {
        var list = global.TFG_ZONES.list()
        for (var i = 0; i < list.length; i++) {
            var zn = list[i]
            if (String(zn.dim) !== dim) continue
            var lab = String(zn.label || "")
            if (lab.indexOf("тропа") >= 0 || lab.indexOf("рельеф") >= 0) continue
            var b = zn.box
            if (x >= b.x1 && x <= b.x2 && z >= b.z1 && z <= b.z2 && y >= b.y1 && y <= b.y2) return true
        }
    } catch (e) { }
    return false
}

/**
 * Природное ли дерево у (x, y, z): ствол из брёвен стоит на земле, к нему примыкает листва,
 * рядом нет рукотворных блоков, и это не зона постройки. Иначе null - брёвна дома не трогаем.
 * Возвращает { x, y, z } - основание ствола.
 */
function seNaturalTree(level, x, y, z) {
    var dim = String(level.getDimension())
    // найти бревно рядом с точкой
    var lx = null, ly = null, lz = null
    for (var dy = -2; dy <= 6 && lx === null; dy++) {
        for (var dx = -1; dx <= 1 && lx === null; dx++) for (var dz = -1; dz <= 1 && lx === null; dz++) {
            if (SE_LOG_RE.test(seIdAt(level, x + dx, y + dy, z + dz))) { lx = x + dx; ly = y + dy; lz = z + dz }
        }
    }
    if (lx === null) return null
    // спуститься по стволу к земле
    var by = ly
    while (by > ly - 40 && SE_LOG_RE.test(seIdAt(level, lx, by - 1, lz))) by--
    var ground = seIdAt(level, lx, by - 1, lz)
    if (!/(grass|dirt|rooted|podzol|mud|clay|sand|gravel)/.test(ground) || /path|farmland/.test(ground)) return null
    if (seInBuiltZone(dim, lx, by, lz)) return null
    // листва над стволом и ничего рукотворного вокруг
    var leaves = false
    for (var uy = 1; uy <= 30 && !leaves; uy++) {
        for (var ax = -3; ax <= 3 && !leaves; ax += 3) for (var az = -3; az <= 3 && !leaves; az += 3) {
            if (seIdAt(level, lx + ax, by + uy, lz + az).indexOf("leaves") >= 0) leaves = true
        }
    }
    if (!leaves) return null
    for (var cy = 0; cy <= 3; cy++) {
        for (var cx = -2; cx <= 2; cx++) for (var cz = -2; cz <= 2; cz++) {
            if (SE_MANMADE_RE.test(seIdAt(level, lx + cx, by + cy, lz + cz))) return null
        }
    }
    return { x: lx, y: by, z: lz }
}

/** Ищем природное дерево вокруг поселения - сперва ближе, до maxR от середины. */
function seFindTree(level, v, e, maxR) {
    for (var t = 0; t < 120; t++) {
        // кольца расширяются: первые попытки ближе, последние - у самого края
        var r = 24 + (maxR - 24) * Math.sqrt(t / 120)
        var a = Math.random() * 6.283185307179586
        var x = Math.floor(v.x + Math.cos(a) * r), z = Math.floor(v.z + Math.sin(a) * r)
        try { if (!level.hasChunk(x >> 4, z >> 4)) continue } catch (err) { continue }
        var h = 0
        try { h = Number(level.getHeight("MOTION_BLOCKING", x, z)) } catch (err) { continue }
        if (seIdAt(level, x, h - 1, z).indexOf("leaves") < 0) continue      // сверху должна быть крона
        var tree = seNaturalTree(level, x, h - 8, z)
        if (tree) return tree
    }
    return null
}

/**
 * Идти к далёкой точке. Навигация моба не строит путь дальше его дальности следования
 * (около 48 блоков), поэтому к далёкой цели - перебежками по 32 блока.
 */
function seGoFar(e, v, x, z, speed) {
    var dx = x - e.getX(), dz = z - e.getZ(), d = Math.sqrt(dx * dx + dz * dz)
    if (d <= 36) { seGo(e, v, x, z, speed); return }
    var px = e.getX() + dx / d * 32, pz = e.getZ() + dz / d * 32
    var py = e.getY()
    try { py = Number(e.level.getHeight("MOTION_BLOCKING_NO_LEAVES", Math.floor(px), Math.floor(pz))) } catch (err) { }
    seMove(e, px, py, pz, speed)
}

/** Подобрать добычу: выпавшие вещи вокруг точки - «в мешок» (убираются из мира). */
function seCollect(v, x, y, z, r) {
    seRun("execute in " + v.dim + " run kill @e[type=minecraft:item,x=" + Math.floor(x) + ",y=" + Math.floor(y) +
        ",z=" + Math.floor(z) + ",distance=.." + r + "]")
}

/** Свалить дерево целиком: все связанные брёвна от основания. Число срубленных. */
function seFell(level, v, j) {
    var base = seNaturalTree(level, j.x, j.y, j.z)
    if (!base) return 0                                    // уже не дерево (срубили, или это постройка)
    var seen = {}, stack = [[base.x, base.y, base.z]], logs = []
    while (stack.length && logs.length < SE_FELL_MAX) {
        var p = stack.pop()
        var k = p[0] + "," + p[1] + "," + p[2]
        if (seen[k]) continue
        seen[k] = 1
        if (Math.abs(p[0] - base.x) > 12 || Math.abs(p[2] - base.z) > 12 || p[1] < base.y || p[1] > base.y + 60) continue
        var id = seIdAt(level, p[0], p[1], p[2])
        if (!SE_LOG_RE.test(id)) continue
        logs.push(p)
        if (!j.wood) { var mw = id.match(/\/([a-z_]+)$/); if (mw) j.wood = mw[1] }
        for (var dx = -1; dx <= 1; dx++) for (var dy = 0; dy <= 1; dy++) for (var dz = -1; dz <= 1; dz++) {
            if (dx || dy || dz) stack.push([p[0] + dx, p[1] + dy, p[2] + dz])
        }
    }
    // сверху вниз, чтобы ничего не повисло
    logs.sort((a, b) => b[1] - a[1]).forEach(p => {
        seRun("execute in " + v.dim + " run setblock " + p[0] + " " + p[1] + " " + p[2] + " minecraft:air destroy")
    })
    j.x = base.x; j.y = base.y; j.z = base.z
    seRun("execute in " + v.dim + " run playsound minecraft:block.wood.break block @a " + base.x + " " + base.y + " " + base.z + " 1.2 0.6")
    seLog("лесоруб поселения " + v.id + " свалил дерево (" + (j.wood || "?") + "), брёвен " + logs.length)
    return logs.length
}

/** На месте пня - саженец той же породы. */
function seReplant(level, v, j) {
    if (!j.wood) return
    var sap = "tfc:wood/sapling/" + j.wood
    try { if (global.TFG_STRUCTURES.exists && !global.TFG_STRUCTURES.exists(sap)) return } catch (e) { }
    var under = seIdAt(level, j.x, j.y - 1, j.z)
    if (!/(grass|dirt|rooted|podzol)/.test(under)) return
    seRun("execute in " + v.dim + " run setblock " + j.x + " " + j.y + " " + j.z + " " + sap + " replace")
}

function seChop(level, v, e, j) {
    for (var dy = 0; dy <= 6; dy++) {
        for (var dx = -3; dx <= 3; dx++) {
            for (var dz = -3; dz <= 3; dz++) {
                var x = j.x + dx, y = j.y + dy, z = j.z + dz
                var id = ""
                try { id = String(level.getBlock(x, y, z).id) } catch (err) { continue }
                var m = id.match(/^tfc:wood\/log\/([a-z_]+)$/)
                if (!m) continue
                seRun("execute in " + v.dim + " run setblock " + x + " " + y + " " + z + " minecraft:air destroy")
                // саженец на землю рядом: лесоруб сажает больше, чем рубит
                for (var sx = -2; sx <= 2; sx++) {
                    for (var sz = -2; sz <= 2; sz++) {
                        var gx = x + sx, gz = z + sz
                        var gy = 0
                        try { gy = Number(level.getHeight("WORLD_SURFACE_WG", gx, gz)) } catch (err) { continue }
                        var under = ""
                        try { under = String(level.getBlock(gx, gy - 1, gz).id) } catch (err) { continue }
                        if (under.indexOf("tfc:grass/") !== 0 && under.indexOf("tfc:dirt/") !== 0) continue
                        var top = ""
                        try { top = String(level.getBlock(gx, gy, gz).id) } catch (err) { continue }
                        if (top !== "minecraft:air" && top.indexOf("tfc:plant/") !== 0) continue
                        var sap = "tfc:wood/sapling/" + m[1]
                        try { if (!global.TFG_STRUCTURES.exists(sap)) return } catch (err) { }
                        seRun("execute in " + v.dim + " run setblock " + gx + " " + gy + " " + gz + " " + sap + " replace")
                        return
                    }
                }
                return
            }
        }
    }
}

// ─── Песня барда ─────────────────────────────────────────────────────────────

// Мод immersive_melodies даёт настоящие инструменты: звуки вида lute.c4, flute.c4.
// Высоту ноты задаём тоном playsound - так из одной ноты получается вся гамма.
const SE_INSTRUMENTS = ["immersive_melodies:lute.c4", "immersive_melodies:flute.c4", "immersive_melodies:bagpipe.c4"]
const SE_TUNES = [
    [0, 4, 7, 4, 0, -5, 0, 4, 7, 12, 7, 4],
    [0, 2, 4, 5, 7, 5, 4, 2, 0, 0, 4, 7],
    [7, 5, 4, 2, 0, 2, 4, 5, 7, 7, 4, 0],
    [0, 3, 5, 7, 10, 7, 5, 3, 0, -2, 0, 3],
]
var SE_PLAY = {}                     // uuid -> { notes, i, next, inst, dim }

const SE_PLAY_TIME = 900             // сорок пять секунд игры
const SE_PLAY_REST = 2400            // и две минуты тишины после

/**
 * Начать или продолжить песню. Играет ТОЛЬКО бард (он же певунья): у прочих ролей
 * инструмента нет и быть не должно - на это и жаловались, когда заиграл рыцарь.
 * Наигрыш идёт сорок с лишним секунд подряд, потом бард отдыхает пару минут.
 */
/**
 * Песня барда - настоящая мелодия Immersive Melodies: инструмент в руке с запущенной мелодией
 * (как у музыкантов гостей, factions/social.js), и каждый клиент рядом сам играет её целиком.
 * Раньше бард «играл» по нотам командой playsound, а она слала звук не туда (расстояние
 * считалось от начала координат мира) - слышно не было, и бард просто махал рукой.
 */
function seTune(level, v, e) {
    if (seRoleOf(e) !== "бард") return
    var u = String(e.uuid)
    var now = Number(level.getTime())
    var p = SE_PLAY[u]
    if (p && p.melody && now < p.until) return            // играет - пусть доиграет
    if (p && !p.melody && p.until && now < p.until) return
    var melodies = [], instruments = []
    try { melodies = SO_MELODIES; instruments = SO_INSTRUMENTS } catch (err) { }
    // Рядом уже играет бард - подхватываем ту же мелодию с того же такта, на своём инструменте: выходит
    // ансамбль. Раньше каждый играл своё, и на площади стояла какофония.
    var lead = seBandLead(e, v, u, now)
    if (lead && !lead.start) { SE_PLAY[u] = { melody: null, until: now + 200, notes: [], i: 0 }; return }   // подхватить нечем - ждём
    if (melodies.length && instruments.length && typeof gsInstrumentStack === "function") {
        var melody = lead ? lead.melody : sePick(melodies)
        var inst = lead ? (sePick(instruments.filter(x => x !== lead.inst)) || lead.inst) : sePick(instruments)
        var start = lead ? lead.start : now
        try {
            e.setMainHandItem(gsInstrumentStack(inst, melody, start))
            if (typeof soPlayStart === "function") soPlayStart(e, inst, melody, start)
            var len = typeof soMelodyTicks === "function" ? soMelodyTicks(melody) : 1200
            SE_PLAY[u] = { melody: melody, inst: inst, dim: v.dim, e: e, village: v, start: start,
                until: lead ? lead.until : now + len + 60, notes: [], i: 0 }
            return
        } catch (err) { seErr("инструмент барда", err) }
    }
    if (lead) { SE_PLAY[u] = { melody: null, until: now + 200, notes: [], i: 0 }; return }     // по нотам вторить не умеем - молчим
    // запасной путь: наигрыш по нотам
    SE_PLAY[u] = {
        notes: SE_TUNES[Math.floor(Math.random() * SE_TUNES.length)],
        i: 0, next: 0, inst: SE_INSTRUMENTS[Math.floor(Math.random() * SE_INSTRUMENTS.length)],
        dim: v.dim, e: e, village: v, until: now + SE_PLAY_TIME, restUntil: 0,
    }
}

/** Бард, что уже играет мелодию в 32 блоках от e (запись SE_PLAY), или null. */
function seBandLead(e, v, u, now) {
    for (var k in SE_PLAY) {
        var q = SE_PLAY[k]
        if (k === u || !q || !q.melody || !q.e || now >= q.until || q.dim !== v.dim) continue
        try { if (q.e.isAlive() && q.e.distanceToSqr(e) < 32 * 32) return q } catch (err) { }
    }
    return null
}

/** Песня по заказу игрока (factions/dialogue.js): бард стоит, смотрит на заказчика и играет. */
function seOrderSong(e, melody, player) {
    if (seRoleOf(e) !== "бард" || typeof gsInstrumentStack !== "function") return false
    var vid = seTagValue(e, "tfg_v_")
    var v = vid ? seLoad().villages[vid] : null
    if (!v || v.state !== "мир") return false
    var u = String(e.uuid), now = Number(e.level.getTime())
    var inst = "immersive_melodies:lute"
    try { inst = sePick(SO_INSTRUMENTS) } catch (err) { }
    e.setMainHandItem(gsInstrumentStack(inst, melody, now))
    if (typeof soPlayStart === "function") soPlayStart(e, inst, melody, now)
    var len = typeof soMelodyTicks === "function" ? soMelodyTicks(melody) : 1200
    SE_PLAY[u] = { melody: melody, inst: inst, dim: v.dim, e: e, village: v, start: now, until: now + len + 40, notes: [], i: 0, ordered: true }
    try { global.TFG_NPC_HOLD.hold(e, player, len + 40, "song") } catch (err) { }
    return true
}

function seBardBusy(e) {
    var p = SE_PLAY[String(e.uuid)]
    try { return !!(p && p.melody && Number(e.level.getTime()) < p.until) } catch (err) { return false }
}

/** Бард перестаёт играть: мелодию из рук долой. Заказанную игроком песню распорядок не обрывает (force - обрывает). */
function seStopPlay(u, force) {
    var p = SE_PLAY[u]
    if (p && p.ordered && !force) {
        var tnow = 0
        try { tnow = Number(p.e.level.getTime()) } catch (err) { }
        if (tnow < p.until) return
    }
    delete SE_PLAY[u]
    if (p && p.melody && p.e) { try { p.e.setMainHandItem(Item.of("minecraft:air")) } catch (err) { } }
}

ServerEvents.tick(event => {
    if (event.server.tickCount % 5 !== 0) return
    if (!SE_SERVER) SE_SERVER = event.server
    for (var u in SE_PLAY) {
        var p = SE_PLAY[u]
        if (!p || !p.e || !p.e.isAlive()) { delete SE_PLAY[u]; continue }
        // Состояние берём из нынешних данных: запись в p.village - старая копия, в ней «мир»
        // оставался и во время налёта, и бард играл посреди боя.
        var pv = null
        try { pv = p.village ? seLoad().villages[p.village.id] : null } catch (err) { }
        if (!pv || pv.state !== "мир") { seStopPlay(u, true); continue }
        var e = p.e
        var now = Number(e.level.getTime())
        if (p.melody) {
            if (now >= p.until) { seStopPlay(u, true); continue }   // доиграл - следующую заведёт seTune
        } else {
            if (p.i >= p.notes.length) continue               // наигрыш кончился, новый заведёт seTune
            var pitch = Math.pow(2, p.notes[p.i] / 12)
            if (pitch < 0.5) pitch = 0.5
            if (pitch > 2) pitch = 2
            p.i++
            try {
                e.swing(SE_MAIN_HAND)
                // positioned: «distance» считается от барда, а не от начала координат мира
                SE_SERVER.runCommandSilent("execute in " + p.dim + " positioned " + e.getX().toFixed(1) + " " + e.getY().toFixed(1) + " " +
                    e.getZ().toFixed(1) + " run playsound " + p.inst + " record @a[distance=..48] ~ ~ ~ 1.4 " + pitch.toFixed(3))
            } catch (err) { delete SE_PLAY[u] }
        }
        // слушатели поворачиваются к музыканту
        if (event.server.tickCount % 20 === 0) {
            try {
                seEntities(SE_SERVER.overworld(), p.village).forEach(o => {
                    var dx = o.getX() - e.getX(), dz = o.getZ() - e.getZ()
                    if (o === e || dx * dx + dz * dz > 144) return
                    o.getLookControl().setLookAt(e.getX(), e.getEyeY(), e.getZ())
                })
            } catch (err) { }
        }
    }
})
// ─── Сторож простоя и отчёт ──────────────────────────────────────────────────

var SE_WATCH = {}                    // uuid -> { x, z, at, still }
var SE_STATS = {}                    // id поселения -> { at, told, moved, duties }

/**
 * Присмотр за тем, что жители действительно живут. Раз в двадцать секунд смотрим,
 * сдвинулся ли каждый; кто стоит без причины - того отправляем гулять принудительно.
 * Раз в минуту всё это уходит в лог: тогда «не работает» проверяется по цифрам.
 */
function seWatch(level, v, e, duty) {
    var u = String(e.uuid), now = Number(level.getTime())
    var w = SE_WATCH[u]
    if (!w) { SE_WATCH[u] = { x: e.getX(), z: e.getZ(), at: now, still: 0 }; return }
    var st = SE_STATS[v.id] || (SE_STATS[v.id] = { at: now, told: 0, moved: 0, forced: 0, stepped: 0, duties: {} })
    st.duties[duty] = (st.duties[duty] || 0) + 1
    var mv = SE_MOVE[u]
    if (mv && mv.gx !== undefined && now - (mv.at || 0) < 40) st.told++
    if (now - w.at < 400) return
    var dx = e.getX() - w.x, dz = e.getZ() - w.z
    var far = dx * dx + dz * dz > 2.25
    if (far) st.moved++
    w.x = e.getX()
    w.z = e.getZ()
    w.at = now
    if (far) { w.still = 0; return }
    // стоять положено спящему, сидящему и беседующему - остальным нет
    if (duty === "спать") return
    // Стоит на своём месте - это не простой: правитель у колокола, торговец за прилавком,
    // спрятавшийся во дворе, лесоруб у дерева, бард у костра. Раньше их всех через двадцать
    // секунд сгоняли «гулять» - отсюда правитель без колокола, пустые лавки и толпа у ворот.
    // Застрявший - только тот, кому велено идти, а он стоит далеко от цели.
    var mvw = SE_MOVE[u]
    var wants = mvw && mvw.gx !== undefined && now - (mvw.at || 0) < 200 &&
        Math.pow(mvw.gx - e.getX(), 2) + Math.pow(mvw.gz - e.getZ(), 2) > 6.25
    if (!wants) { w.still = 0; return }
    var act = null
    try { act = gsRt("village_" + v.id).acts[u] } catch (err) { }
    if (act && (act.id === "talk" || act.id === "sit" || act.id === "warm")) return
    w.still++
    st.forced++
    try {
        delete SE_JOB[u]
        delete SE_ROUTE[u]
        if (act) { gsRt("village_" + v.id).acts[u] = null; delete gsRt("village_" + v.id).acts[u] }
    } catch (err) { }
    seWander(e, v, (v.ring || 28) + 20 + w.still * 10, 1)

    // Сорок секунд стоит, хотя идти велено, - значит ноги не идут: путь не строится
    // (заперт мебелью, лестницей, дверью) или навигация молчит. Тогда шагаем переносом:
    // по нескольку блоков в сторону цели. Поселение не имеет права выглядеть мёртвым.
    if (w.still >= 2) {
        var m2 = SE_MOVE[u]
        if (m2 && m2.gx !== undefined) {
            var gx = m2.gx - e.getX(), gz = m2.gz - e.getZ()
            var d = Math.sqrt(gx * gx + gz * gz) || 1
            var stepLen = Math.min(6, d)
            var nx = e.getX() + gx / d * stepLen, nz = e.getZ() + gz / d * stepLen
            var ny = e.getY()
            try { ny = Number(level.getHeight("WORLD_SURFACE_WG", Math.floor(nx), Math.floor(nz))) } catch (err) { }
            seRun("execute in " + v.dim + " run tp " + u + " " + nx.toFixed(2) + " " + ny + " " + nz.toFixed(2))
            st.stepped++
        }
    }
    if (w.still >= 4) {                                   // совсем зажат - на тропу
        w.still = 0
        var m = SE_MOVE[u]
        if (m) m.outs = 2
        try { seStuck(e, v) } catch (err) { seErr("вызволение", err) }
    }
}

/** Раз в минуту - строка в лог: сколько кого и сколько из них двигалось. */
function seReport(level, v, ents) {
    var now = Number(level.getTime())
    var st = SE_STATS[v.id]
    if (!st) return
    if (now - st.at < 1200) return
    var duties = []
    for (var k in st.duties) duties.push(k + " " + Math.round(st.duties[k] / 60))
    seLog("поселение " + v.id + ": жителей " + ents.length + ", велено идти " + st.told +
        ", сдвинулись " + st.moved + ", расшевелили " + st.forced + ", шагов переносом " + st.stepped +
        ", занятия: " + duties.join(", ") + ", гости " + (typeof gsActTick === "function" ? "видны" : "НЕ ВИДНЫ"))
    SE_STATS[v.id] = { at: now, told: 0, moved: 0, forced: 0, stepped: 0, duties: {} }
}

// ─── Речь над головой, а не в чат ────────────────────────────────────────────

const SE_MAIN_HAND = (function () {
    try { return Java.loadClass("net.minecraft.world.InteractionHand").MAIN_HAND } catch (e) { return null }
})()

var SE_SAID = {}                     // uuid -> до какого тика висит реплика

// Человеческие звуки без слов: они озвучены для всех голосов набора.
const SE_BREATH = ["*вздыхает*", "*дышит на руки*", "*кашляет*", "*зевает*"]

/** Сказать над головой голосом гостя: в чат поселение больше не пишет. */
function seVoice(e, text) {
    try {
        if (typeof gsSay !== "function") return false
        // Запись есть не у каждой реплики (свои строки поселения пока не озвучены).
        // Тогда вместо немой сцены - живой человеческий звук из общего набора.
        var voice = text
        var known = false
        try { known = !!gsVoiceKeyOf(text) } catch (err2) { }
        if (!known) voice = null            // без записи - молча: шумы Piper звучали рыком
        gsSay(e, null, text, voice)
        SE_SAID[String(e.uuid)] = Number(e.level.getTime()) + 60 + text.length * 2
        return true
    } catch (err) { return false }
}

/** Вернуть жителю его имя после реплики. Зовут и гости - через gsRestoreName. */
function seRestoreSettlerName(e) {
    try {
        var vid = seTagValue(e, "tfg_v_"), sid = seTagValue(e, "tfg_sid_")
        var v = vid && seLoad().villages[vid]
        var rec = v && v.settlers.filter(x => x.id === sid)[0]
        if (!rec) return
        var text = Text.of(seTitle(rec, v.faction))
        try { text = text.color(seNameColor(v.faction)) } catch (err) { }
        e.setCustomName(text)
        e.setCustomNameVisible(true)
    } catch (err) { }
}

function seSaidTick(level, ents) {
    var now = Number(level.getTime())
    ents.forEach(e => {
        var u = String(e.uuid)
        if (!SE_SAID[u] || now < SE_SAID[u]) return
        delete SE_SAID[u]
        seRestoreSettlerName(e)
    })
}

// ─── Урон жителям от игрока ──────────────────────────────────────────────────

EntityEvents.hurt(event => {
    try {
        var e = event.entity
        if (!e || !e.getTags || !e.getTags().contains("tfg_settler")) return
        var src = null
        try { src = event.source && event.source.player } catch (e2) { }
        if (!src) {
            // бьёт не игрок (или KubeJS не отдал игрока) - для разбора это тоже важно
            if (SE_HURT_TOLD < 3) { SE_HURT_TOLD++; seLog("удар по жителю без игрока в источнике") }
            return
        }
        var data = seLoad()
        var vid = null
        var it = e.getTags().iterator()
        while (it.hasNext()) {
            var t = String(it.next())
            if (t.indexOf("tfg_v_") === 0) vid = t.substring(6)
        }
        var v = vid && data.villages[vid]
        if (!v) return
        var share = Number(event.damage) / Math.max(1, Number(e.getMaxHealth()))
        seLog("удар по жителю: " + Math.round(share * 100) + "% здоровья, бил " + String(src.username || src.uuid))
        seNoteHostile(v, String(src.uuid), "удар", share)
    } catch (err) { seErr("урон", err) }
})

EntityEvents.death(event => {
    try {
        var e = event.entity
        if (!e || !e.getTags || !e.getTags().contains("tfg_settler")) return
        var data = seLoad()
        var vid = null, sid = null
        var it = e.getTags().iterator()
        while (it.hasNext()) {
            var t = String(it.next())
            if (t.indexOf("tfg_v_") === 0) vid = t.substring(6)
            if (t.indexOf("tfg_sid_") === 0) sid = t.substring(8)
        }
        var v = vid && data.villages[vid]
        if (!v) return
        v.settlers.forEach(s => { if (s.id === sid) s.dead = true })
        seLog("житель " + sid + " убит (" + v.id + ")")
        seCheckSurrender(v)
        seSave()
    } catch (err) { seErr("смерть", err) }
})

// ─── Наружу ──────────────────────────────────────────────────────────────────

global.TFG_SETTLERS = {
    estateOf: s => seEstateOf(s),
    save: () => seSave(),
    crewOut: (vid, visitId, guards) => seCrewOut(vid, visitId, guards),
    crewHome: visitId => seCrewHome(visitId),
    make: (level, streetId, owner, faction, roster) => seMake(level, streetId, owner, faction, roster),
    spawn: (level, v) => seSpawn(level, v),
    despawn: v => seDespawn(v),
    list: () => seLoad().villages,
    alarm: (v, why) => seAlarm(v, why),
    raid: (level, v, f) => seRaid(level, v, f),
    playSong: (e, melody, player) => seOrderSong(e, melody, player),     // песня на заказ (dialogue.js)
    bardBusy: e => seBardBusy(e),
    hostile: (v, uuid, kind, amount) => seNoteHostile(v, uuid, kind, amount),
    upkeep: (level, v, force) => seUpkeep(level, v, force),
    // заселить, как только стройка закончится: улица ставится очередью по тикам
    buildLater: job => { SE_BUILD = job; return true },
    // улицу сносят - поселение обязано уйти вместе с ней
    purge: streetId => {
        var data = seLoad()
        var n = 0
        for (var id in data.villages) {
            if (data.villages[id].settlement !== streetId) continue
            seDrop(data.villages[id], "улицу снесли")
            n++
        }
        return n
    },
}

// ─── Деревня одной командой ──────────────────────────────────────────────────

var SE_BUILD = null                  // { street, owner, at, told }

/**
 * Заселение отложено: улица ставится очередью по тикам, и пока последний блок не лёг,
 * коек в домах ещё нет. Поэтому ждём конца стройки и только потом делаем поселение.
 */
function seBuildTick(level) {
    if (!SE_BUILD) return
    var now = Number(level.getTime())
    var busy = true
    try { busy = global.TFG_STREET.busy() || global.TFG_STRUCTURES.busy() } catch (e) { busy = false }
    if (busy) {
        if (now - SE_BUILD.at > 12000) { seLog("стройка затянулась, заселение отменено"); SE_BUILD = null }
        return
    }
    var job = SE_BUILD
    SE_BUILD = null
    try { global.TFG_STREET.light(level, global.TFG_STREET.list()[job.street]) } catch (e) { }
    var v = seMake(level, job.street, job.owner, job.faction, job.roster)
    if (typeof v === "string") { seSay2(job.owner, "§cзаселить не вышло: " + v); return }
    var n = seSpawn(level, v)
    // реестр мира должен знать, что поселение встало, и запомнить снимок для пересборки
    if (job.done) { try { job.done(v, n) } catch (e2) { seErr("после стройки", e2) } }
    seSay2(job.owner, n < 0 ? "§cжители не вышли, смотрите лог"
        : "Деревня готова: " + (job.name ? job.name + " (" + v.id + ")" : v.id) +
          ", жителей " + n + " (фракция " + v.faction + ")")
}

/** Сказать хозяину команды, как всё вышло. */
function seSay2(uuid, text) {
    if (!uuid) return
    seRun("tellraw " + uuid + " {\"text\":\"" + text.replace(/"/g, "'") + "\"}")
}

// ─── Команды ─────────────────────────────────────────────────────────────────

/** /tfgvillage build - улица, постройки, свет и жители одной командой. */
function seCmdBuild(ctx, houses) {
    if (!SE_SERVER) SE_SERVER = ctx.source.getServer()
    var p = ctx.source.getPlayerOrException()
    var res = null
    try { res = global.TFG_STREET.build(p.level, Math.floor(p.getX()) + 30, Math.floor(p.getZ()) + 30, houses, String(p.uuid)) }
    catch (e) { ctx.source.sendFailure(Text.of("§cулица не встала: " + e)); return 1 }
    if (typeof res === "string") { ctx.source.sendFailure(Text.of("§c" + res)); return 1 }
    SE_BUILD = { street: res.id, owner: String(p.uuid), at: Number(p.level.getTime()) }
    ctx.source.sendSuccess(Text.of("Строю деревню " + res.id + ": построек " + res.buildings.length +
        ". Заселю, как только встанет последний блок."), false)
    return 1
}

ServerEvents.commandRegistry(event => {
    try {
        var Commands = event.commands
        var Arguments = event.arguments
        var str = name => Commands.argument(name, Arguments.STRING.create(event))
        var S = (ctx, name) => String(Arguments.STRING.getResult(ctx, name))

        // Берём ближайшее ЖИВОЕ поселение: у призраков (улицу снесли) и пустышек
        // (ни одного жителя в записи) делать нечего, а раньше spawn попадал именно в них.
        var nearest = player => {
            var data = seLoad()
            var best = null, bestD = 1e18, ghost = null, ghostD = 1e18
            for (var id in data.villages) {
                var v = data.villages[id]
                if (v.dim !== String(player.level.getDimension())) continue
                var dx = v.x - player.getX(), dz = v.z - player.getZ()
                var d = dx * dx + dz * dz
                if (seGhost(v) || !v.settlers.length) {
                    if (d < ghostD) { ghostD = d; ghost = v }
                    continue
                }
                if (d < bestD) { bestD = d; best = v }
            }
            if (!best && ghost) seLog("рядом только запись-призрак " + ghost.id + " (улица " + ghost.settlement + ")")
            return best
        }

        event.register(Commands.literal("tfgvillage").requires(s => s.hasPermission(2))
            // /tfgvillage make <идентификатор поселения из /tfgstreet list>
            .then(Commands.literal("make").then(str("улица")
                .then(str("фракция").executes(ctx => {
                    if (!SE_SERVER) SE_SERVER = ctx.source.getServer()
                    var p = ctx.source.getPlayerOrException()
                    var res = seMake(p.level, S(ctx, "улица"), String(p.uuid), S(ctx, "фракция"))
                    if (typeof res === "string") ctx.source.sendFailure(Text.of("§c" + res))
                    else ctx.source.sendSuccess(Text.of("Поселение жителей " + res.id + " (" + res.faction + "): " +
                        res.settlers.length + " человек, коек " + res.beds), false)
                    return 1
                }))
                .executes(ctx => {
                if (!SE_SERVER) SE_SERVER = ctx.source.getServer()
                var p = ctx.source.getPlayerOrException()
                var res = seMake(p.level, S(ctx, "улица"), String(p.uuid))
                if (typeof res === "string") ctx.source.sendFailure(Text.of("§c" + res))
                else ctx.source.sendSuccess(Text.of("Поселение жителей " + res.id + " (" + res.faction + "): " +
                    res.settlers.length + " человек, коек " + res.beds), false)
                return 1
            })))
            // Заселить ближайшее поселение заново и пересобрать постройки - сразу, не дожидаясь
            // двух суток после сдачи: /tfgvillage restore [фракция]. Только пересборка: restore same.
            .then(Commands.literal("restore")
                .then(str("фракция").executes(ctx => seCmdRestore(ctx, S(ctx, "фракция"))))
                .executes(ctx => seCmdRestore(ctx, null)))
            // Сила ближайшего поселения: /tfgvillage power <1-10> (0 - снова по числу жителей).
            // Жители переодеваются и перевооружаются сразу: их выпускают заново.
            .then(Commands.literal("power").then(Commands.argument("тир", Arguments.INTEGER.create(event)).executes(ctx => {
                if (!SE_SERVER) SE_SERVER = ctx.source.getServer()
                var p = ctx.source.getPlayerOrException()
                var v = nearest(p)
                if (!v) { ctx.source.sendFailure(Text.of("Поселений поблизости нет.")); return 1 }
                var t = Number(Arguments.INTEGER.getResult(ctx, "тир"))
                if (t > 0) v.power = Math.max(1, Math.min(10, t)); else delete v.power
                if (v.spawned) { seDespawn(v); seSpawn(SE_SERVER.overworld(), v) }
                seSave()
                ctx.source.sendSuccess(Text.of("Поселение " + v.id + ": сила " + seVillageTier(v) +
                    (v.power ? " (задана вручную)" : " (по числу жителей: " + v.settlers.length + ")") +
                    ", доспехи рыцарей: " + seMetalFor(seVillageTier(v))), false)
                return 1
            })))
            // Деревня целиком: улица, постройки, свет и жители - одной командой.
            .then(Commands.literal("build")
                .then(Commands.argument("домов", Arguments.INTEGER.create(event)).executes(ctx =>
                    seCmdBuild(ctx, Number(Arguments.INTEGER.getResult(ctx, "домов")))))
                .executes(ctx => seCmdBuild(ctx, 0)))
            // Снести всё: жителей, постройки, тропы - и вернуть дикую природу.
            .then(Commands.literal("wipe").executes(ctx => {
                if (!SE_SERVER) SE_SERVER = ctx.source.getServer()
                var p = ctx.source.getPlayerOrException()
                var street = null
                try { street = global.TFG_STREET.nearest(p.getX(), p.getZ()) } catch (e) { }
                if (!street) { ctx.source.sendFailure(Text.of("Деревень поблизости нет.")); return 1 }
                var res = null
                try { res = global.TFG_STREET.remove(street.id) } catch (e) { }
                if (!res) { ctx.source.sendFailure(Text.of("§cне вышло снести " + street.id)); return 1 }
                ctx.source.sendSuccess(Text.of("Снесено начисто: улица " + street.id + ", зон " + res.zones +
                    ", поселений " + res.villages + ". Рельеф вернётся как был."), false)
                return 1
            }))
            // Показать ремесло: /tfgvillage work <кого> - на десять минут житель занят своим делом
            // в любое время суток, без вечера у барда и сна. <кого>: роль (крестьянин, охотник,
            // лесоруб, бард, торговец, дружинник, правитель, рыцарь, стрелок), все, этот (на кого
            // смотрите) или стоп (вернуть обычный распорядок).
            .then(Commands.literal("work").then(Commands.argument("кого", Arguments.GREEDY_STRING.create(event))
                .executes(ctx => seCmdWork(ctx, String(Arguments.GREEDY_STRING.getResult(ctx, "кого")).trim()))))
            // Разбор на месте: видно ли поселение, кого нашли, чем заняты и двигаются ли.
            .then(Commands.literal("diag").executes(ctx => {
                if (!SE_SERVER) SE_SERVER = ctx.source.getServer()
                var p = ctx.source.getPlayerOrException()
                var v = nearest(p)
                if (!v) { ctx.source.sendFailure(Text.of("Поселений поблизости нет.")); return 1 }
                var level = SE_SERVER.overworld()
                var ents = seEntities(level, v)
                var t = Number(level.getDayTime()) % SE_DAY
                var rows = ["§f" + v.id + " §7(" + v.state + "), заселено: " + (v.spawned ? "да" : "нет") +
                    ", в записи " + v.settlers.length + ", найдено в мире " + ents.length,
                    "§7время суток " + t + " (" + (seIsNight(level) ? "ночь - спят" : "день") + ")"]
                rows.push("§7гости: " + (typeof gsActTick === "function" ? "видны" : "§cНЕ ВИДНЫ") +
                    ", вех на тропах " + ((v.graph && v.graph.nodes && v.graph.nodes.length) || 0) +
                    ", грядок " + ((SE_SPOTS[v.id] && SE_SPOTS[v.id].fields.length) || 0) +
                    ", деревьев " + ((SE_SPOTS[v.id] && SE_SPOTS[v.id].trees.length) || 0))
                var night = seIsNight(level)
                var shown = 0
                ents.forEach(e => {
                    if (shown++ >= 8) return
                    var role = seRoleOf(e)
                    var sid = seSidOf(e)
                    var rec = v.settlers.filter(x => x.id === sid)[0]
                    var duty = seDuty(v, role, sid, night, rec ? rec.shift : undefined)
                    var job = SE_JOB[String(e.uuid)]
                    var act = null
                    try { act = gsRt("village_" + v.id).acts[String(e.uuid)] } catch (err) { }
                    var w = SE_WATCH[String(e.uuid)]
                    var moved = w ? Math.round(Math.sqrt(Math.pow(e.getX() - w.x, 2) + Math.pow(e.getZ() - w.z, 2))) : -1
                    rows.push("§7" + role + ": занятие " + duty +
                        (job ? ", работа " + job.id : "") + (act ? ", у гостей " + act.id + "/" + act.stage : "") +
                        ", сдвиг " + moved + " бл.")
                })
                // проверка на месте: велим первому пойти к форту и смотрим, взялась ли навигация
                if (ents.length) {
                    var e0 = ents[0]
                    var ok = "нет"
                    try { ok = String(e0.getNavigation().moveTo(v.x + 0.5, e0.getY(), v.z + 0.5, 1.2)) } catch (err) { ok = "ошибка " + err }
                    rows.push("§7навигация на форт: " + ok)
                }
                ctx.source.sendSuccess(Text.of(rows.join("\n")), false)
                return 1
            }))
            // Снести все записи от улиц, которых больше нет, вместе с их жителями.
            .then(Commands.literal("clean").executes(ctx => {
                if (!SE_SERVER) SE_SERVER = ctx.source.getServer()
                var data = seLoad()
                var gone = [], kept = 0
                for (var id in data.villages) {
                    var v = data.villages[id]
                    if (seGhost(v) || !v.settlers.length) { gone.push(id); seDrop(v, "уборка по команде") }
                    else kept++
                }
                ctx.source.sendSuccess(Text.of("Убрано записей-призраков: " + gone.length +
                    ", осталось живых: " + kept + (gone.length ? "\n§7" + gone.join(", ") : "")), false)
                return 1
            }))
            .then(Commands.literal("list").executes(ctx => {
                if (!SE_SERVER) SE_SERVER = ctx.source.getServer()
                var data = seLoad()
                var rows = []
                for (var id in data.villages) {
                    var v = data.villages[id]
                    rows.push((seGhost(v) ? "§c" : "§f") + id + " §7улица " + v.settlement + ", " + v.x + " " + v.z +
                        ", жителей " + v.settlers.filter(s => !s.dead).length + " из " + v.settlers.length +
                        ", гарнизон " + seGarrison(v) + ", состояние " + v.state + (v.spawned ? ", в мире" : "") +
                        (seGhost(v) ? " §c(призрак: улицы нет)" : ""))
                }
                ctx.source.sendSuccess(Text.of(rows.length ? rows.join("\n") : "§7поселений нет"), false)
                return 1
            }))
            .then(Commands.literal("info").executes(ctx => {
                if (!SE_SERVER) SE_SERVER = ctx.source.getServer()
                var v = nearest(ctx.source.getPlayerOrException())
                if (!v) { ctx.source.sendFailure(Text.of("Поблизости нет поселений.")); return 1 }
                var by = {}
                v.settlers.forEach(s => { if (!s.dead) by[s.role] = (by[s.role] || 0) + 1 })
                var kinds = []
                for (var k in by) kinds.push(k + " " + by[k])
                ctx.source.sendSuccess(Text.of("§f" + v.id + " §7состояние " + v.state + ", коек " + v.beds +
                    ", гарнизон " + seGarrison(v) + "\n" + kinds.join(", ")), false)
                return 1
            }))
            .then(Commands.literal("spawn").executes(ctx => {
                if (!SE_SERVER) SE_SERVER = ctx.source.getServer()
                var p = ctx.source.getPlayerOrException()
                var v = nearest(p)
                if (!v) { ctx.source.sendFailure(Text.of("Поблизости нет поселений.")); return 1 }
                var n = seSpawn(p.level, v)
                if (n < 0) {
                    ctx.source.sendFailure(Text.of("§cПоселение " + v.id + " не заселить: улицы " +
                        v.settlement + " больше нет или в записи нет жителей. Уберите мусор: /tfgvillage clean"))
                    return 1
                }
                ctx.source.sendSuccess(Text.of("Поселение " + v.id + " (улица " + v.settlement + "): вышло жителей " +
                    n + " из " + v.settlers.length), false)
                return 1
            }))
            .then(Commands.literal("despawn").executes(ctx => {
                if (!SE_SERVER) SE_SERVER = ctx.source.getServer()
                var v = nearest(ctx.source.getPlayerOrException())
                if (!v) { ctx.source.sendFailure(Text.of("Поблизости нет поселений.")); return 1 }
                seDespawn(v)
                ctx.source.sendSuccess(Text.of("Жители убраны, записи сохранены."), false)
                return 1
            }))
            .then(Commands.literal("schedule").executes(ctx => {
                if (!SE_SERVER) SE_SERVER = ctx.source.getServer()
                var p = ctx.source.getPlayerOrException()
                var v = nearest(p)
                if (!v) { ctx.source.sendFailure(Text.of("Поблизости нет поселений.")); return 1 }
                var night = seIsNight(p.level)
                var rows = v.settlers.filter(s => !s.dead).slice(0, 24).map(s =>
                    "§f" + s.name + " §7(" + s.role + (s.female ? ", женщина" : "") +
                    (SE_ROLES[s.role] && SE_ROLES[s.role].sleeps === "смена" ? (s.shift ? ", смена ночная" : ", смена дневная") : "") + ") - " +
                    seDuty(v, s.role, s.id, night, s.shift))
                ctx.source.sendSuccess(Text.of((night ? "Ночь. " : "День. ") + "Занятия:\n" + rows.join("\n")), false)
                return 1
            }))
            .then(Commands.literal("alarm").executes(ctx => {
                if (!SE_SERVER) SE_SERVER = ctx.source.getServer()
                var v = nearest(ctx.source.getPlayerOrException())
                if (!v) { ctx.source.sendFailure(Text.of("Поблизости нет поселений.")); return 1 }
                seAlarm(v, "команда")
                ctx.source.sendSuccess(Text.of("Тревога объявлена."), false)
                return 1
            }))
            // Налёт на ближайшее поселение - настоящий рейд (tfg/raids.js), как на базу игрока:
            //   /tfgvillage raid            - враждебная этому поселению фракция, иначе разбойники;
            //   /tfgvillage raid <фракция>  - одна из фракций или bandits;
            //   /tfgvillage raid stop       - отменить все налёты: налётчики исчезают, тревога снята.
            .then(Commands.literal("raid")
                .executes(ctx => seCmdRaid(ctx, null))
                .then(Commands.literal("stop").executes(ctx => {
                    if (!SE_SERVER) SE_SERVER = ctx.source.getServer()
                    var res = global.TFG_SIEGES.clear()
                    ctx.source.sendSuccess(Text.of("Налёты отменены: " + res.raids + ", налётчиков убрано: " + res.raiders +
                        ". Поселения в мирном режиме."), false)
                    return 1
                }))
                .then(str("фракция").executes(ctx => seCmdRaid(ctx, S(ctx, "фракция")))))
            .then(Commands.literal("upkeep").executes(ctx => {
                if (!SE_SERVER) SE_SERVER = ctx.source.getServer()
                var p = ctx.source.getPlayerOrException()
                var v = nearest(p)
                if (!v) { ctx.source.sendFailure(Text.of("Поблизости нет поселений.")); return 1 }
                seUpkeep(p.level, v, true)
                ctx.source.sendSuccess(Text.of("Присмотр выполнен: состав пополнен."), false)
                return 1
            }))
            .then(Commands.literal("remove").executes(ctx => {
                if (!SE_SERVER) SE_SERVER = ctx.source.getServer()
                var v = nearest(ctx.source.getPlayerOrException())
                if (!v) { ctx.source.sendFailure(Text.of("Поблизости нет поселений.")); return 1 }
                seDespawn(v)
                var data = seLoad()
                delete data.villages[v.id]
                seSave()
                ctx.source.sendSuccess(Text.of("Записи о жителях удалены. Постройки убираются через /tfgstreet remove."), false)
                return 1
            })))
        seLog("/tfgvillage зарегистрирован")      // видно в логе: команда точно встала
    } catch (err) {
        console.error("[settlers] ошибка регистрации команд: " + err)
    }
})
