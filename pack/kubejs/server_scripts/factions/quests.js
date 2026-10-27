// priority: -10
"use strict";
/**
 * ПОРУЧЕНИЯ ЖИТЕЛЕЙ (этап 6 плана NPC: Downloads/TFG-NPC-план.md).
 *
 * «Есть для меня работа?» в окне разговора. Житель, который относится к игроку хотя бы ровно, даёт одно
 * поручение из четырёх видов:
 *   - принести  - заказ на конкретную вещь (QS_ORDERS): стальной меч идеальной ковки, золотое копьё для парада,
 *                 безупречное ожерелье, диадема с сапфиром, нож охотнику, лютня барду...; кто что закажет - по
 *                 ремеслу и сословию. Прежние «16 зерна» (QS_WANTS) больше не выдаются - только сдаются взятые;
 *   - сделать   - вещь с его именем, выгравированным на столе гравёра (engraving.js);
 *   - проучить  - его недруга (граф отношений): пригрозить («Пригрозить» у недруга) или убить;
 *   - разузнать - чужой секрет (talk.js: сплетни) и рассказать ему.
 * Угроза удаётся, если недруг ранен, хуже защищён, рядом нет его друзей, а с игроком свои; нет - недруг
 * злится и поручение остаётся. Награда: монеты, отношение заказчика, репутация у его народа.
 *
 * Поручения игрока - в его данных (tfg_quests): не больше пяти разом, у одного жителя - одно.
 * /tfgquests - список своих поручений. Постоянные реплики озвучены, подробности (имена, сколько) - пометкой.
 */

const QS_MAX = 5
const QS_COOLDOWN_DAYS = 1           // после сданного поручения житель думает сутки, прежде чем дать новое
const QS_DAY = 24000

// что нужно по ремеслу: проверка предмета, сколько, за сколько монет
const QS_WANTS = {
    grain: { label: "зерна", re: /^tfc:food\/[a-z_]+_grain$/, n: 16, pay: 40, say: "Зерна бы мне. Мешок-другой, до урожая не дотянем." },
    meat: { label: "жареного мяса", re: /^tfc:food\/cooked_/, n: 10, pay: 45, say: "Принеси жареного мяса. Сам не успеваю, а есть хочется всем." },
    hide: { label: "сырых шкур", re: /^tfc:(small|medium|large)_raw_hide$/, n: 4, pay: 50, say: "Шкуры нужны. Сырые, любые, лишь бы целые." },
    logs: { label: "брёвен", re: /^(tfc|afc):wood\/log\//, n: 32, pay: 40, say: "Брёвен бы. Стену подлатать, да и на зиму." },
    iron: { label: "слитков железа или стали", re: /^gtceu:(steel|wrought_iron|iron)_ingot$/, n: 6, pay: 90, say: "Мне нужен металл. Сталь или железо, в слитках." },
    gems: { label: "самоцветов", re: /^gtceu:[a-z_]+_gem$/, n: 3, pay: 100, say: "Самоцветы ищу. Огранка не важна, огранщик у меня свой." },
    cloth: { label: "шерстяной ткани", re: /^tfc:wool_cloth$/, n: 8, pay: 60, say: "Ткани бы шерстяной. Зима близко, а люди в обносках." },
    gold: { label: "слитков золота", re: /^gtceu:gold_ingot$/, n: 4, pay: 150, say: "Казне нужно золото. Принесёшь - в долгу не останусь." },
}
const QS_ROLE_WANTS = {
    "крестьянин": ["grain", "cloth"], "охотник": ["hide", "meat"], "лесоруб": ["logs", "meat"],
    "рыцарь": ["iron", "meat"], "стрелок": ["iron", "hide"], "дружинник": ["iron", "meat"],
    "бард": ["cloth", "gems"], "торговец": ["gems", "hide"], "правитель": ["gold", "iron"],
}

// ─── Заказы: конкретная вещь, с качеством ковки, работой и материалом ────────
//
// Ковка - метка TFC tfc:forging_bonus (1 скромно, 2 хорошо, 3 отлично, 4 идеально); её переносят и
// инструменты GregTech, и латы Epic Knights. Украшения tfgui: tfgui:jewel/<вид>/<металл>/<работа>/<камень>[/<бока>],
// работа - regular (обычная), flawless (безупречная), exquisite (изысканная).
// who: роли, которые такое закажут; знать - любой знатный. probe - есть ли такой предмет в сборке.

const QS_MIL = ["рыцарь", "дружинник", "стрелок", "правитель"]

const QS_ORDERS = [
    { id: "sword4", who: QS_MIL, probe: "gtceu:steel_sword", re: /^gtceu:[a-z_]*steel_sword$/, forge: 4, pay: 320,
        say: "Нужен меч из стали, откованный идеально. Хуже - не возьму.", note: "Стальной меч (любая сталь GregTech), ковка - идеальная." },
    { id: "goldpike", who: QS_MIL, probe: "magistuarmory:gold_pike", re: /^magistuarmory:gold_(pike|ahlspiess|chivalrylance|ranseur|guisarme)$/, pay: 260,
        say: "Копьё из золота хочу. Для парада - пусть блестит на солнце.", note: "Золотое древковое Epic Knights: пика, альшпис, рыцарское копьё, рансер или гизарма." },
    { id: "zwei", who: QS_MIL, probe: "magistuarmory:steel_zweihander", re: /^magistuarmory:steel_zweihander$/, pay: 240,
        say: "Цвайхендер из стали. Настоящий двуручник, а не игрушку.", note: "Стальной цвайхендер Epic Knights." },
    { id: "armet2", who: QS_MIL, probe: "magistuarmory:armet", re: /^magistuarmory:armet$/, forge: 2, pay: 220,
        say: "Шлем-армет, откованный хотя бы хорошо. В старом уже дыра.", note: "Армет Epic Knights, ковка - хорошая или лучше." },
    { id: "pavese", who: QS_MIL, probe: "magistuarmory:steel_pavese", re: /^magistuarmory:steel_pavese$/, pay: 180,
        say: "Павезу из стали. В строю за ней стоять.", note: "Стальная павеза Epic Knights." },
    { id: "flame", who: QS_MIL, probe: "magistuarmory:silver_flamebladedsword", re: /^magistuarmory:silver_flamebladedsword$/, pay: 260,
        say: "Пламенеющий меч хочу, из серебра. Красивый, говорят, и страшный в бою.", note: "Серебряный фламберг Epic Knights." },
    { id: "crusader3", who: ["правитель", "рыцарь"], probe: "magistuarmory:crusader_chestplate", re: /^magistuarmory:crusader_chestplate$/, forge: 3, pay: 380,
        say: "Кирасу крестоносца, откованную отлично. Для того, кто поведёт войско.", note: "Кираса крестоносца Epic Knights, ковка - отличная или лучше." },
    { id: "necklace", who: ["знать"], probe: "tfgui:jewel/necklace/gold", re: /^tfgui:jewel\/necklace\/gold\/(flawless|exquisite)\//, pay: 420,
        say: "Безупречное ожерелье. Золото и камни, без единого изъяна.", note: "Золотое ожерелье с камнями безупречной (или изысканной) работы." },
    { id: "diadem", who: ["знать"], probe: "tfgui:jewel/diadem/gold", re: /^tfgui:jewel\/diadem\/(gold|platinum)\/exquisite\/sapphire/, pay: 520,
        say: "Диадему изысканной работы, с сапфиром. Дочери к свадьбе.", note: "Диадема из золота или платины изысканной работы, в центре сапфир." },
    { id: "ringdia", who: ["знать", "торговец"], probe: "tfgui:jewel/ring/gold", re: /^tfgui:jewel\/ring\/[a-z_]+\/[a-z]+\/diamond/, pay: 450,
        say: "Кольцо с бриллиантом. Обручальное - пусть знают, что я не скупой.", note: "Кольцо любого металла, в центре алмаз." },
    { id: "earrings", who: ["знать", "бард"], probe: "tfgui:jewel/earrings/gold", re: /^tfgui:jewel\/earrings\/[a-z_]+\/[a-z]+\/emerald/, pay: 300,
        say: "Серьги с изумрудами. Металл любой, а камень чтоб настоящий.", note: "Серьги любого металла, в центре изумруд." },
    { id: "brooch", who: ["знать", "торговец", "бард"], probe: "tfgui:jewel/brooch/gold", re: /^tfgui:jewel\/brooch\/[a-z_]+\/[a-z]+\/ruby/, pay: 280,
        say: "Брошь с рубином, на плащ. Праздник скоро.", note: "Брошь любого металла, в центре рубин." },
    { id: "bracelet", who: ["знать"], probe: "tfgui:jewel/bracelet/rose_gold", re: /^tfgui:jewel\/bracelet\/rose_gold\/(regular|flawless|exquisite)\//, pay: 300,
        say: "Браслет из розового золота, с камнями. Без камней не надо.", note: "Браслет розового золота с любыми камнями." },
    { id: "polarcoat", who: ["знать"], probe: "tfgui:fur_coat_polar_bear", re: /^tfgui:fur_coat_polar_bear$/, pay: 350,
        say: "Шубу из шкуры белого медведя. Знатному человеку - знатный мех.", note: "Шуба из меха белого медведя." },
    { id: "mead", who: ["правитель", "торговец"], probe: "tfcagedalcohol:bucket/aged_mead", re: /^tfcagedalcohol:bucket\/aged_mead$/, pay: 200,
        say: "Ведро выдержанной медовухи. Гости приедут - стыдно угощать молодой.", note: "Ведро выдержанной медовухи (TFC Aged Alcohol)." },
    { id: "cheese", who: ["знать", "торговец", "крестьянин"], probe: "firmalife:food/gouda", re: /^firmalife:food\/(gouda|cheddar)$/, pay: 120,
        say: "Головку гауды или чеддера. Настоящего, выдержанного.", note: "Сыр гауда или чеддер (Firmalife)." },
    { id: "scythe2", who: ["крестьянин"], probe: "gtceu:bronze_scythe", re: /^gtceu:[a-z_]+_scythe$/, forge: 2, pay: 150,
        say: "Косу бы, откованную хорошо. Моя уже не косит, а мнёт.", note: "Коса GregTech, ковка - хорошая или лучше." },
    { id: "axe3", who: ["лесоруб"], probe: "gtceu:bronze_axe", re: /^gtceu:[a-z_]+_axe$/, forge: 3, pay: 180,
        say: "Топор, откованный отлично. Чтоб дуб с трёх ударов.", note: "Топор GregTech, ковка - отличная или лучше." },
    { id: "knife4", who: ["охотник"], probe: "gtceu:bronze_knife", re: /^gtceu:[a-z_]+_knife$/, forge: 4, pay: 220,
        say: "Нож, откованный идеально. Шкуру снимать - дело тонкое.", note: "Нож GregTech, ковка - идеальная." },
    { id: "cleaver3", who: ["охотник", "крестьянин"], probe: "gtceu:bronze_butchery_knife", re: /^gtceu:[a-z_]+_butchery_knife$/, forge: 3, pay: 170,
        say: "Тесак мясника, выкованный на совесть. Хотя бы отлично.", note: "Тесак мясника GregTech, ковка - отличная или лучше." },
    { id: "smoked", who: ["крестьянин", "охотник", "лесоруб"], probe: "tfc:food/pork", re: /^tfc:food\//, nbt: "smoked", pay: 90,
        say: "Копчёного окорока бы. Как следует прокопчённого, чтоб до весны лежал.", note: "Любое мясо TFC с отметкой «копчёное»." },
    { id: "wolfcoat", who: ["лесоруб", "охотник"], probe: "tfgui:fur_coat_direwolf", re: /^tfgui:fur_coat_direwolf$/, pay: 250,
        say: "Тёплую шубу, из лютоволка. Зима близко.", note: "Шуба из меха лютоволка." },
    { id: "vessel", who: ["крестьянин", "торговец"], probe: "tfc:ceramic/large_vessel/blue", re: /^tfc:ceramic\/large_vessel\/blue$/, pay: 110,
        say: "Большой сосуд с синей глазурью. Зерно хранить, да и глазу приятно.", note: "Большой керамический сосуд синей глазури." },
    { id: "lute", who: ["бард"], probe: "immersive_melodies:lute", re: /^immersive_melodies:lute$/, pay: 200,
        say: "Новую лютню. Старая треснула, а без неё я не певец.", note: "Лютня (Immersive Melodies)." },
    { id: "vielle", who: ["бард"], probe: "immersive_melodies:vielle", re: /^immersive_melodies:vielle$/, pay: 220,
        say: "Виелу бы мне. Говорят, у вас мастера есть.", note: "Виела (Immersive Melodies)." },
]

function qsOrder(id) { return QS_ORDERS.filter(o => o.id === id)[0] || null }

/** Качество ковки предмета: 0 - нет, 4 - идеально. */
function qsForge(st) {
    try { var t = st.getTag(); return t && t.contains("tfc:forging_bonus") ? Number(t.getInt("tfc:forging_bonus")) : 0 } catch (e) { return 0 }
}

function qsOrderOk(o, st) {
    if (!o.re.test(String(st.id))) return false
    if (o.forge && qsForge(st) < o.forge) return false
    if (o.nbt) { var t = st.getTag(); if (!t || String(t.toString()).indexOf(o.nbt) < 0) return false }
    return true
}

function qsOrdersFor(s) {
    var estate = global.TFG_SETTLERS.estateOf(s)
    return QS_ORDERS.filter(o => (o.who.indexOf(s.role) >= 0 || (estate === "знать" && o.who.indexOf("знать") >= 0)) &&
        (!o.probe || o.probe.indexOf("tfgui:jewel/") === 0 || enExists(o.probe)))
}

const QS_ASK_ENGRAVE ="Хочу вещь с моим именем. Чтобы знали, чья. Закажи у гравёра - любую, лишь бы металл."
const QS_ASK_RIVAL = "Есть тут один, кто мне жить не даёт. Проучи его. Как - решай сам."
const QS_ASK_SECRET = "Хочу знать, что скрывает один человек. Разузнай и расскажи мне."
const QS_NONE = ["Нет у меня для тебя работы.", "Ничего не нужно, спасибо.", "Сами справляемся."]
const QS_BUSY = "У тебя и так дел по горло. Сперва с прежними разберись."
const QS_COOL = "Ты мне уже помог. Дай подумать, чем ещё."
const QS_TAKE = ["Вот и договорились.", "По рукам."]
const QS_LATER = "Ну, как знаешь."
const QS_NOT_YET = ["Ещё не сделал? Жду.", "Не торопись, но и не тяни.", "Помню, помню. Жду."]
const QS_THANKS = ["Вот это дело! Держи, заслужил.", "Не обманул. Держи плату.", "Спасибо тебе. Не забуду."]
const QS_RIVAL_DONE = "Слышал, ты его проучил. Вот это по-нашему. Держи."
const QS_SECRET_TOLD = "Вот оно как... Ну, спасибо. Держи, это твоё."
const QS_DROP = "Не вышло - и ладно. Найду другого."
const QS_SCARED = ["Ладно, ладно! Я понял. Больше не буду.", "Всё, всё, отстань! Понял я."]
const QS_BRAVE = ["Пошёл вон, пока цел.", "Ты мне угрожаешь? Здесь, при всех?", "Уходи. Ещё слово - и пожалеешь."]

function qsLog(msg) { try { global.tfgLog("tfg quest", msg) } catch (e) { } }
function qsDay(level) { return Math.floor(Number(level.getTime()) / QS_DAY) }

function qsLoad(player) {
    try { return JSON.parse(String(player.persistentData.getString("tfg_quests")) || "[]") } catch (e) { return [] }
}
function qsSave(player, list) { player.persistentData.putString("tfg_quests", JSON.stringify(list.slice(-40))) }
function qsActive(list) { return list.filter(q => q.state === "идёт") }
function qsOf(list, vid, sid) { return qsActive(list).filter(q => q.v === vid && q.sid === sid)[0] || null }

function qsName(v, id) { var o = v.settlers.filter(x => x.id === id)[0]; return o ? o.name : "кто-то" }

// ─── Выдать поручение ────────────────────────────────────────────────────────

/** Какое поручение даст житель (или null). */
function qsPlan(v, s) {
    var roll = Math.random()
    var foes = rlLinks(v, s.id).filter(l => l.mine < -30 && v.settlers.some(x => x.id === l.other && !x.dead))
    if (foes.length && roll < 0.3) return { type: "проучить", target: foes[0].other }
    if (roll < 0.5) {
        var others = v.settlers.filter(x => !x.dead && x.id !== s.id && tkSecrets(v, x).length)
        if (others.length) return { type: "разузнать", target: others[Math.floor(Math.random() * others.length)].id }
    }
    if (roll < 0.6) return { type: "сделать" }
    var orders = qsOrdersFor(s)
    if (!orders.length) return { type: "сделать" }
    return { type: "принести", order: orders[Math.floor(Math.random() * orders.length)].id }
}

function qsDescribe(v, q) {
    if (q.type === "принести" && q.order) { var o = qsOrder(q.order); return "Заказ " + qsName(v, q.sid) + ": " + (o ? o.note : "?") + " Плата " + (o ? o.pay : 0) + " медяков." }
    if (q.type === "принести") { var w = QS_WANTS[q.want]; return "Принести " + qsName(v, q.sid) + ": " + w.label + ", " + w.n + " шт. Плата " + w.pay + " медяков." }
    if (q.type === "сделать") return "Принести " + qsName(v, q.sid) + " металлическую вещь с его именем, выгравированным на столе гравёра. Плата 120 медяков."
    if (q.type === "проучить") return "Проучить " + qsName(v, q.target) + " по просьбе " + qsName(v, q.sid) + ": пригрозить («Пригрозить» в разговоре) или убить. Плата 100 медяков."
    return "Узнать секрет " + qsName(v, q.target) + " (расспросить его близких или врагов) и рассказать " + qsName(v, q.sid) + ". Плата 70 медяков."
}

function qsOffer(ctx) {
    var w = tkWho(ctx)
    if (!w) return dlgSay(ctx, gsPick(QS_NONE))
    if (rlTier(w.op.value) <= 1) return dlgSay(ctx, gsPick(TK_REFUSE))
    var list = qsLoad(ctx.player)
    if (qsActive(list).length >= QS_MAX) return dlgSay(ctx, QS_BUSY)
    var day = qsDay(ctx.player.level)
    if (list.some(q => q.v === w.v.id && q.sid === w.s.id && q.state === "сдано" && day - q.doneDay < QS_COOLDOWN_DAYS)) return dlgSay(ctx, QS_COOL)
    var plan = qsPlan(w.v, w.s)
    if (!plan) return dlgSay(ctx, gsPick(QS_NONE))
    var q = { id: "q" + day + "_" + Math.floor(Math.random() * 1e6), v: w.v.id, sid: w.s.id, type: plan.type, want: plan.want || null, order: plan.order || null,
        target: plan.target || null, day: day, state: "идёт", faction: w.v.faction }
    dlgSay(ctx, q.type === "принести" ? (q.order ? qsOrder(q.order).say : QS_WANTS[q.want].say) : q.type === "сделать" ? QS_ASK_ENGRAVE : q.type === "проучить" ? QS_ASK_RIVAL : QS_ASK_SECRET)
    var text = qsDescribe(w.v, q)
    dlgNote(ctx, text)
    dlgChoice(ctx, null, [
        { label: "Берусь", hint: text, run: c => {
            var l2 = qsLoad(c.player)
            if (qsOf(l2, q.v, q.sid)) return dlgSay(c, gsPick(QS_TAKE))
            l2.push(q)
            qsSave(c.player, l2)
            c.player.tell(Text.of("§6[Поручение] §7" + text))
            dlgSay(c, gsPick(QS_TAKE))
        } },
        { label: "Не сейчас", hint: "Отказаться", run: c => dlgSay(c, QS_LATER) },
    ])
}

// ─── Сдать поручение ─────────────────────────────────────────────────────────

/** Сколько в инвентаре вещей, подходящих под проверку; take - забрать столько. */
function qsTakeItems(player, test, need, take) {
    var inv = player.inventory, have = 0
    for (var i = 0; i < inv.getContainerSize(); i++) { var st = inv.getItem(i); if (!st.isEmpty() && test(st)) have += st.getCount() }
    if (!take || have < need) return have
    var left = need
    for (var j = 0; j < inv.getContainerSize() && left > 0; j++) {
        var st2 = inv.getItem(j)
        if (st2.isEmpty() || !test(st2)) continue
        var n = Math.min(left, st2.getCount())
        st2.shrink(n)
        left -= n
    }
    return have
}

function qsPay(ctx, w, q, coins, opinion) {
    try { global.TFG_COINS.give(ctx.player, coins) } catch (e) { }
    rlNote(w.v, ctx.player, w.s.id, opinion, "выполнил поручение")
    try { global.TFG_FACTIONS.addRep(ctx.player, w.v.faction, 3, "поручение жителя") } catch (e) { }
    var list = qsLoad(ctx.player)
    list.forEach(x => { if (x.id === q.id) { x.state = "сдано"; x.doneDay = qsDay(ctx.player.level) } })
    qsSave(ctx.player, list)
    ctx.player.tell(Text.of("§6[Поручение выполнено] §7+" + coins + " медяков"))
    qsLog(ctx.player.username + " сдал поручение " + q.type + " жителю " + w.s.name + " (" + w.v.id + ")")
}

function qsTurnIn(ctx) {
    var w = tkWho(ctx)
    if (!w) return
    var q = qsOf(qsLoad(ctx.player), w.v.id, w.s.id)
    if (!q) return dlgSay(ctx, gsPick(QS_NONE))
    if (q.type === "принести" && q.order) {
        var ord = qsOrder(q.order)
        var fits = st => !!ord && qsOrderOk(ord, st)
        if (!ord || qsTakeItems(ctx.player, fits, 1, false) < 1) { dlgSay(ctx, gsPick(QS_NOT_YET)); return qsDropChoice(ctx, w, q) }
        qsTakeItems(ctx.player, fits, 1, true)
        dlgSay(ctx, gsPick(QS_THANKS))
        return qsPay(ctx, w, q, ord.pay, 18)
    }
    if (q.type === "принести") {
        var want = QS_WANTS[q.want]
        var test = st => want.re.test(String(st.id))
        if (qsTakeItems(ctx.player, test, want.n, false) < want.n) { dlgSay(ctx, gsPick(QS_NOT_YET)); return qsDropChoice(ctx, w, q) }
        qsTakeItems(ctx.player, test, want.n, true)
        dlgSay(ctx, gsPick(QS_THANKS))
        return qsPay(ctx, w, q, want.pay, 12)
    }
    if (q.type === "сделать") {
        var name = String(w.s.name)
        var mine = st => { var g = global.TFG_ENGRAVE.info(st); return !!g && ((g.name || "").indexOf(name) >= 0 || (g.text || "").indexOf(name) >= 0) }
        if (qsTakeItems(ctx.player, mine, 1, false) < 1) { dlgSay(ctx, gsPick(QS_NOT_YET)); return qsDropChoice(ctx, w, q) }
        qsTakeItems(ctx.player, mine, 1, true)
        dlgSay(ctx, gsPick(QS_THANKS))
        return qsPay(ctx, w, q, 120, 18)
    }
    if (q.type === "проучить") {
        if (!q.done) { dlgSay(ctx, gsPick(QS_NOT_YET)); return qsDropChoice(ctx, w, q) }
        dlgSay(ctx, QS_RIVAL_DONE)
        return qsPay(ctx, w, q, 100, 20)
    }
    // разузнать: секрет цели узнан - можно рассказать
    var known = tkKnown(ctx.player).filter(x => x.v === w.v.id && x.sid === q.target)
    if (!known.length) { dlgSay(ctx, gsPick(QS_NOT_YET)); return qsDropChoice(ctx, w, q) }
    dlgChoice(ctx, null, [
        { label: "Рассказать", hint: known[0].text, run: c => { dlgNote(c, "Рассказываешь: " + known[0].text + "."); dlgSay(c, QS_SECRET_TOLD); qsPay(c, w, q, 70, 15) } },
        { label: "Промолчать", hint: "Не выдавать чужую тайну", run: c => dlgSay(c, gsPick(QS_NOT_YET)) },
    ])
}

function qsDropChoice(ctx, w, q) {
    dlgChoice(ctx, null, [
        { label: "Не справлюсь, прости", hint: "Отказаться от поручения - он немного огорчится", run: c => {
            var list = qsLoad(c.player)
            list.forEach(x => { if (x.id === q.id) x.state = "брошено" })
            qsSave(c.player, list)
            rlNote(w.v, c.player, w.s.id, -3, "бросил поручение")
            dlgSay(c, QS_DROP)
        } },
    ])
}

// ─── Проучить: угроза и убийство ─────────────────────────────────────────────

/** Удастся ли запугать жителя e (запись s в поселении v). */
function qsCanScare(player, e, v, s) {
    var score = 0
    var hpE = Number(e.getHealth()) / Math.max(1, Number(e.getMaxHealth()))
    var hpP = Number(player.getHealth()) / Math.max(1, Number(player.getMaxHealth()))
    if (hpE < 0.6) score += 2                                    // ранен
    if (hpP > hpE + 0.2) score += 1
    if (Number(player.getArmorValue()) > Number(e.getArmorValue()) + 4) score += 1
    if (SE_FIGHTERS.indexOf(s.role) >= 0) score -= 1             // воин так просто не испугается
    // его друзья и родня рядом - заступятся; свои рядом с игроком - на его стороне
    var friends = rlLinks(v, s.id).filter(l => l.mine > 30).map(l => l.other)
    seEntities(player.level, v).forEach(o => {
        try {
            if (String(o.uuid) === String(e.uuid) || o.distanceToSqr(e) > 144) return
            var sid = seTagValue(o, "tfg_sid_")
            if (friends.indexOf(sid) >= 0) score -= 2
        } catch (err) { }
    })
    try {
        player.server.players.forEach(p => { if (p !== player && p.level === player.level && p.distanceToSqr(player) < 144) score += 1 })
    } catch (err) { }
    return score >= 2
}

function qsScare(ctx) {
    var w = tkWho(ctx)
    if (!w) return
    var list = qsLoad(ctx.player)
    var q = qsActive(list).filter(x => x.type === "проучить" && x.v === w.v.id && x.target === w.s.id)[0]
    if (!q) return
    if (qsCanScare(ctx.player, ctx.trader, w.v, w.s)) {
        rlNote(w.v, ctx.player, w.s.id, -20, "запугал")
        list.forEach(x => { if (x.id === q.id) x.done = true })
        qsSave(ctx.player, list)
        dlgSay(ctx, gsPick(QS_SCARED))
        ctx.player.tell(Text.of("§6[Поручение] §7" + w.s.name + " запуган. Вернись к " + qsName(w.v, q.sid) + "."))
    } else {
        rlNote(w.v, ctx.player, w.s.id, -10, "угрожал")
        dlgSay(ctx, gsPick(QS_BRAVE))
        dlgNote(ctx, "Не испугался: он цел, при оружии или рядом его друзья.")
    }
}

EntityEvents.death(event => {
    try {
        var p = event.source.player
        if (!p) return
        var who = rlSettlerOf(event.entity)
        if (!who) return
        var list = qsLoad(p), hit = false
        list.forEach(q => { if (q.state === "идёт" && q.type === "проучить" && q.v === who.v.id && q.target === who.sid) { q.done = true; hit = true } })
        // убил заказчика - поручение пропало
        list.forEach(q => { if (q.state === "идёт" && q.v === who.v.id && q.sid === who.sid) { q.state = "брошено"; hit = true } })
        if (hit) qsSave(p, list)
    } catch (e) { }
})

// ─── В окно разговора ────────────────────────────────────────────────────────

;(() => {
    if (typeof DLG_NPC_OPTIONS === "undefined") return
    var isSettler = ctx => { try { return ctx.trader.getTags().contains("tfg_settler") } catch (e) { return false } }
    var here = ctx => { var who = rlSettlerOf(ctx.trader); return who ? qsOf(qsLoad(ctx.player), who.v.id, who.sid) : null }
    var scareable = ctx => {
        var who = rlSettlerOf(ctx.trader)
        return !!who && qsActive(qsLoad(ctx.player)).some(q => q.type === "проучить" && !q.done && q.v === who.v.id && q.target === who.sid)
    }
    var opts = [
        { id: "qs_offer", label: () => "Есть для меня работа?", hint: () => "Поручение: принести, сделать, проучить, разузнать.",
            show: ctx => isSettler(ctx) && !here(ctx), run: ctx => qsOffer(ctx) },
        { id: "qs_turnin", label: () => "Насчёт твоего поручения", hint: () => "Сдать поручение или отказаться от него.",
            show: ctx => isSettler(ctx) && !!here(ctx), run: ctx => qsTurnIn(ctx) },
        { id: "qs_scare", label: () => "Пригрозить", hint: () => "Удастся, если он ранен или слабее, рядом нет его друзей, а с тобой свои.",
            show: ctx => isSettler(ctx) && scareable(ctx), run: ctx => qsScare(ctx) },
    ]
    ;[DLG_NPC_OPTIONS, typeof DLG_OPTIONS !== "undefined" ? DLG_OPTIONS : null].forEach(list => {
        if (!list) return
        // поручения - сразу за «Поговорить»: внизу длинного списка их не видно
        opts.forEach((opt, k) => {
            if (list.some(x => x.id === opt.id)) return
            var talk = list.findIndex(o => o.id === "talk")
            var at = talk >= 0 ? talk + 1 + k : list.findIndex(o => o.id === "leave")
            list.splice(at < 0 ? list.length : at, 0, opt)
        })
    })
})()

// /tfgquests - мои поручения
ServerEvents.commandRegistry(event => {
    event.register(event.commands.literal("tfgquests").executes(ctx => {
        var p = ctx.source.getPlayerOrException()
        var act = qsActive(qsLoad(p))
        if (!act.length) { p.tell(Text.of("§7Поручений нет. Спроси жителей: «Есть для меня работа?»")); return 1 }
        var vs = global.TFG_SETTLERS.list()
        act.forEach(q => {
            var v = vs[q.v]
            p.tell(Text.of("§6• §7" + (v ? qsDescribe(v, q) : "поселения больше нет") + (q.done ? " §a(сделано - вернись за платой)" : "")))
        })
        return 1
    }))
})

global.TFG_QUESTS = {
    list: player => qsLoad(player),
    active: player => qsActive(qsLoad(player)),
}
