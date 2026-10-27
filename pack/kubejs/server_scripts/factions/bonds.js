// priority: -11
"use strict";
/**
 * УЗЫ С ЖИТЕЛЕМ: как сблизиться с конкретным человеком (перед этапом 7 плана NPC).
 *
 *   «Поговорить по душам» - житель заводит тему (их 14), игрок выбирает ответ: посочувствовать, пошутить,
 *     возразить, расспросить, ответить по вере. Реакция - по нраву жителя (тот же нрав, что в дневнике:
 *     diaries_data.js DY_MOODS). Дружба от разговора растёт раз в игровой день с каждого жителя.
 *   Житель сам окликает игрока: рядом, вне боя, отношение не хуже ровного - раз в день открывает окно
 *     «Эй, есть минутка?». /tfgchat off - не окликать.
 *   «Где найти…?» - прохожий скажет, где живёт нужный житель: дом, сторона от середины, координаты.
 *   «Подарить…» - вещь из инвентаря через окно. У каждого свои вкусы (2 любимых вида вещей, 3 приятных,
 *     1 нелюбимый; от ремесла и от имени), мусор - обида. Один подарок в день.
 *   В шапке окна - отношение и к фракции, и к самому жителю.
 * Постоянные реплики озвучены, имена и подробности - пометкой.
 */

const BD_DAY = 24000
const BD_HAIL_R = 4                   // ближе этого житель может окликнуть
const BD_HAIL_PLAYER_CD = 6000        // одного игрока окликают не чаще раза в пять минут
const BD_TIER_NAME = ["враг", "холоден", "ровно", "приятель", "друг"]

var BD_HAIL_AT = {}                   // uuid игрока -> тик сервера последнего оклика

function bdLog(msg) { try { global.tfgLog("tfg bonds", msg) } catch (e) { } }
function bdDay(level) { return Math.floor(Number(level.getTime()) / BD_DAY) }
function bdPick(a) { return a[Math.floor(Math.random() * a.length)] }
function bdHash(s) { try { return rlHash(s) } catch (e) { var h = 0; for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0; return h } }

/** Нрав жителя - тот же, что пишет его дневник. */
function bdMood(v, s) {
    var moods = []
    try { moods = Object.keys(DY_MOODS) } catch (e) { }
    return moods.length ? moods[bdHash(String(v.id) + "#" + s.id + "mood") % moods.length] : "весёлый"
}

/** Отметка «сегодня уже было»: v.bonds[uuid|sid|что] = день. */
function bdOnce(v, player, sid, what, day) {
    v.bonds = v.bonds || {}
    var k = String(player.uuid) + "|" + sid + "|" + what
    if (v.bonds[k] === day) return false
    v.bonds[k] = day
    return true
}

// ─── Отношение в шапке окна ──────────────────────────────────────────────────

/** «фракция 35 · лично 42, приятель» - для dialogue.js (шапка окна). */
function bdRepLine(ctx) {
    var line = "фракция " + Math.round(ctx.rep)
    try {
        var w = tkWho(ctx)
        if (w) line += " · лично " + Math.round(w.op.value) + ", " + BD_TIER_NAME[rlTier(w.op.value)]
    } catch (e) { }
    return line
}

// ─── Разговор по душам ───────────────────────────────────────────────────────

// виды ответа: базовый сдвиг отношения
const BD_TONES = { "тепло": 2, "шутка": 1, "расспросить": 1, "вера": 1, "спор": -2 }
// нрав: что ему особенно по душе и что - нет
const BD_MOOD_TONE = {
    "мрачный": { "тепло": 2, "шутка": -2 }, "весёлый": { "шутка": 2, "спор": -1 }, "набожный": { "вера": 2, "шутка": -2 },
    "скупой": { "расспросить": 1, "тепло": -1 }, "трусливый": { "тепло": 2, "спор": -2 }, "мечтательный": { "расспросить": 2, "спор": -1 },
    "вспыльчивый": { "спор": -3, "тепло": 1 },
}
const BD_REACT = {
    "хорошо": ["Вот и я так думаю.", "Хорошо с тобой говорить.", "Ты понимаешь меня, это редкость.", "Спасибо, что выслушал."],
    "так себе": ["Ну, можно и так сказать.", "Может быть.", "Хм. Ладно."],
    "плохо": ["Не ожидал от тебя такого.", "Зря ты так.", "Что-то разговор у нас не клеится.", "Ну и шуточки у тебя."],
}

/**
 * Темы: open - с чего житель начинает; more - что расскажет, если расспросить; replies - ответы игрока.
 * if(w) - тема только при условии. Строки постоянные (озвучены), кроме тех, что собираются в коде.
 */
const BD_TOPICS = [
    { id: "weather", open: ["Видал, какая погода нынче? Всё никак не привыкну.", "Небо хмурое. К дождю, а может, к худу."],
        more: ["Старики говорят, раньше дожди были честные, не старили железо.", "Я по облакам погоду угадываю. Почти всегда."],
        replies: [["Погода как погода, переживём.", "тепло"], ["Главное, чтоб не старящий дождь.", "вера"], ["Нашёл о чём говорить.", "спор"], ["А как ты её угадываешь?", "расспросить"]] },
    { id: "work", open: ["Устал я сегодня. Работы невпроворот.", "Руки уже не те. А работа та же."],
        more: ["Если бы не работа, давно бы с ума сошёл. Она держит.", "Мне бы помощника толкового. Да где его взять."],
        replies: [["Отдохни, ты заслужил.", "тепло"], ["Работа не волк, в лес не убежит.", "шутка"], ["Все работают, не ты один.", "спор"], ["А что самое трудное?", "расспросить"]] },
    { id: "family", open: ["Дома всё по-старому. Свои, родные, а иной раз хоть из дома беги.", "Скучаю по своим, хоть и живём под одной крышей."],
        more: ["Семья - это нити. Порвёшь - и стоишь один на Отмели.", "У меня когда-то была большая семья. Война всех разметала."],
        replies: [["Семья - самое главное.", "тепло"], ["Беги к нам, у нас весело.", "шутка"], ["Сам выбирал, с кем жить.", "спор"], ["Расскажи о них.", "расспросить"]] },
    { id: "faith", open: ["Ты в храм-то ходишь? Или как все нынче?", "Я вот думаю: взвешивает нас Всевышний каждый день или только в конце?"],
        more: ["Я молюсь не о победе. Я молюсь, чтобы не струсить.", "Требник у меня всегда при себе."],
        replies: [["Каждый день - как на весах.", "вера"], ["Мне бы с землёй разобраться, не до неба.", "спор"], ["Вера держит, когда всё рушится.", "тепло"], ["А ты сам во что веришь?", "расспросить"]] },
    { id: "void", open: ["Скажи честно: ты веришь, что Выход Пустоты близко?", "Ночью опять знамения видели. Мне страшно, если честно."],
        more: ["Говорят, на дне незера есть проход на Отмель. Я бы туда ни за что не полез.", "Кто живёт храбро, тому и Выход не страшен. Так говорят. Я не уверен."],
        replies: [["Не бойся, вместе выстоим.", "тепло"], ["Всевышний не оставит своих.", "вера"], ["Сказки для детей.", "спор"], ["А что за знамения?", "расспросить"]] },
    { id: "books", if: w => { try { return tbLiterate(w.v, w.s) } catch (e) { return false } },
        open: ["Читаешь что-нибудь? Я вот книгу недавно закончил.", "Книги - это голоса тех, кого уже нет. Люблю их слушать."],
        more: ["Книгу Тверди я читал раз пять. Каждый раз нахожу новое.", "У нас в поселении книги по сундукам держат. Спроси, может, дадут почитать."],
        replies: [["Хорошая книга дороже меча.", "тепло"], ["Я больше по картинкам.", "шутка"], ["Пустое занятие.", "спор"], ["А что читал?", "расспросить"]] },
    { id: "dream", open: ["О чём ты мечтаешь? Я вот иногда думаю - уйти бы куда глаза глядят.", "Мне бы дом с башенкой. Смешно, да?"],
        more: ["Хочу хоть раз увидеть Фортуну над облаками.", "Мечтаю, чтобы дети жили без войны. Хоть один год."],
        replies: [["Мечты сбываются, если верить.", "тепло"], ["А мне бы мешок золота.", "шутка"], ["Лучше бы делом занялся.", "спор"], ["А что бы ты сделал первым делом?", "расспросить"]] },
    { id: "food", open: ["Чем нынче кормишься, путник? У нас похлёбка да хлеб.", "Эх, поесть бы сейчас мяса с дымком."],
        more: ["Лучшая еда - та, что после работы.", "Моя мать пекла хлеб - вот был хлеб. Теперь так не пекут."],
        replies: [["Угощу как-нибудь.", "тепло"], ["Я ем всё, что не убегает.", "шутка"], ["Не до еды сейчас.", "спор"], ["А что ты любишь?", "расспросить"]] },
    { id: "war", open: ["Говорят, скоро опять война. Ты на чьей стороне?", "Перемирие долго не продержится. Чую."],
        more: ["Я бы не воевал, если бы можно было не воевать.", "Весы Всевышнего не стоят ровно. Кто-то всегда падает."],
        replies: [["На стороне тех, кто рядом.", "тепло"], ["Всевышний рассудит.", "вера"], ["Война - дело сильных.", "спор"], ["А кто начнёт?", "расспросить"]] },
    { id: "you", open: ["Откуда ты родом? Говоришь не по-нашему.", "Ты не здешний. Чем живёшь?"],
        more: ["Мне всегда были интересны чужаки. Они видели мир.", "Если надумаешь осесть - у нас места хватит."],
        replies: [["Издалека. Но здесь мне нравится.", "тепло"], ["Из-под камня вылез.", "шутка"], ["Не твоё дело.", "спор"], ["А ты бывал далеко?", "расспросить"]] },
    { id: "sleep", open: ["Мне сегодня такое приснилось - до сих пор не по себе.", "Плохо сплю последнее время."],
        more: ["Снилась Отмель. Туман и шёпот.", "Снилось, что я за столом Пира. Хороший был сон."],
        replies: [["Сны - это просто сны.", "тепло"], ["К деньгам, наверное.", "шутка"], ["Меньше пить надо.", "спор"], ["Расскажи сон.", "расспросить"]] },
    // собираются в коде: история года, вкусы, сосед
    { id: "story", open: ["Хочу тебе рассказать, что у меня делается.", "Знаешь, у меня тут своя история."], more: [],
        replies: [["Я рад за тебя.", "тепло"], ["Всё образуется.", "вера"], ["Бывает и хуже.", "спор"], ["А дальше что?", "расспросить"]] },
    { id: "likes", open: ["Знаешь, что я люблю? Мало кто спрашивает.", "Хочешь меня порадовать - запоминай."], more: [],
        replies: [["Запомню.", "тепло"], ["А что не любишь?", "расспросить"], ["Подарки любят все.", "шутка"], ["Мне-то что.", "спор"]] },
    { id: "neighbor", open: ["Про соседа нашего слыхал?", "Есть у нас тут один человек..."], more: [],
        replies: [["Не стоит судить людей.", "тепло"], ["Весело тут у вас.", "шутка"], ["Мне сплетни не интересны.", "спор"], ["И что дальше?", "расспросить"]] },
]

/** Строка истории года из дневника - по времени года. */
function bdStoryLine(v, s, level) {
    try {
        var th = DY_THREADS[bdHash(String(v.id) + "#" + s.id + "thread") % DY_THREADS.length]
        var stage = Math.min(3, Math.floor(((bdDay(level) % 360) / 360) * 4))
        return th[stage]
    } catch (e) { return null }
}

function bdTalk(ctx, opening) {
    var w = tkWho(ctx)
    if (!w) return dlgSay(ctx, "Не до разговоров мне.")
    if (rlTier(w.op.value) === 0) return dlgSay(ctx, gsPick(TK_REFUSE))
    var topics = BD_TOPICS.filter(t => !t.if || t.if(w))
    var t = bdPick(topics)
    if (opening) dlgSay(ctx, opening)
    dlgSay(ctx, bdPick(t.open))
    // тема со своими подробностями
    if (t.id === "story") { var st = bdStoryLine(w.v, w.s, ctx.player.level); if (st) dlgSay(ctx, st) }
    if (t.id === "likes") { var pr = bdPrefs(w.v, w.s); dlgSay(ctx, BD_CAT[pr.loves[0]].love) }
    if (t.id === "neighbor") {
        var links = rlLinks(w.v, w.s.id)
        if (links.length) {
            var l = bdPick(links)
            dlgSay(ctx, l.mine < -30 ? "Терпеть его не могу, хоть и живём рядом." : l.mine > 30 ? "Хороший человек, мы с ним давно дружим." : "Живёт себе тихо, никого не трогает.")
            dlgNote(ctx, "Речь о " + tkName(w.v, l.other) + ".")
        }
    }
    var mood = bdMood(w.v, w.s)
    dlgChoice(ctx, null, t.replies.map(r => ({
        label: r[0], hint: "Ответить так",
        run: c => bdReply(c, w, t, r[1], mood),
    })))
}

function bdReply(ctx, w, t, tone, mood) {
    var d = (BD_TONES[tone] || 0) + ((BD_MOOD_TONE[mood] || {})[tone] || 0)
    dlgSay(ctx, bdPick(BD_REACT[d >= 2 ? "хорошо" : d >= 0 ? "так себе" : "плохо"]))
    if (tone === "расспросить") {
        if (t.more.length) dlgSay(ctx, bdPick(t.more))
        if (t.id === "likes") { var pr = bdPrefs(w.v, w.s); dlgSay(ctx, BD_CAT[pr.hates[0]].hate) }
        if (t.id === "story") dlgSay(ctx, "Посмотрим, чем кончится. Расскажу, если не забудешь спросить.")
    }
    // дружба от беседы - раз в день; плохой ответ огорчает всегда
    var day = bdDay(ctx.player.level)
    if (d < 0) rlNote(w.v, ctx.player, w.s.id, d, "неудачный ответ в разговоре")
    else if (bdOnce(w.v, ctx.player, w.s.id, "talk", day)) rlNote(w.v, ctx.player, w.s.id, Math.max(1, d), "поговорили по душам")
    try { global.TFG_SETTLERS.save() } catch (e) { }
}

// ─── Житель сам окликает ─────────────────────────────────────────────────────

const BD_HAIL = ["Эй, постой! Есть минутка?", "Слушай, можно тебя на пару слов?", "О, это ты! Поговорим?", "Погоди, не убегай. Скучно мне."]

function bdHailTick(server) {
    var now = Number(server.tickCount)
    server.players.forEach(p => {
        try {
            var u = String(p.uuid)
            if (p.persistentData.getBoolean("tfg_chat_off") || (BD_HAIL_AT[u] && now - BD_HAIL_AT[u] < BD_HAIL_PLAYER_CD)) return
            if (typeof DLG_SESS !== "undefined" && DLG_SESS[u]) return
            if (!global.TFG_UI.has(p) || p.isSprinting() || p.isPassenger() || p.isSleeping() || p.isInWater()) return
            if (Number(p.getHealth()) < Number(p.getMaxHealth()) * 0.5 || p.hurtTime > 0) return
            var list = p.level.getEntities(p, p.getBoundingBox().inflate(BD_HAIL_R))
            var best = null
            for (var i = 0; i < list.size(); i++) {
                var e = list.get(i)
                if (!e.getTags || !e.getTags().contains("tfg_settler") || e.getTags().contains("tfg_trader")) continue
                if (e.getTarget && e.getTarget()) continue
                best = e
                break
            }
            if (!best) return
            var who = rlSettlerOf(best)
            if (!who || who.v.state !== "мир") return
            var s = who.v.settlers.filter(x => x.id === who.sid)[0]
            if (!s) return
            if (rlTier(rlOpinion(p, who.v, s).value) < 2) return
            // монстры рядом - не до разговоров
            var mobs = p.level.getEntities(p, p.getBoundingBox().inflate(16))
            for (var j = 0; j < mobs.size(); j++) {
                try { if (String(mobs.get(j).getType().getCategory()) === "MONSTER" && !mobs.get(j).getTags().contains("tfg_npc")) return } catch (e2) { }
            }
            if (!bdOnce(who.v, p, s.id, "hail", bdDay(p.level))) return
            BD_HAIL_AT[u] = now
            dlgOpenNpc(p, best)
            var sess = DLG_SESS[u]
            if (!sess) return
            bdTalk(dlgCtx(p, sess), bdPick(BD_HAIL))
            bdLog(s.name + " окликнул " + p.username)
        } catch (e) { }
    })
}

ServerEvents.tick(event => {
    if (event.server.tickCount % 100 !== 50) return
    try { bdHailTick(event.server) } catch (e) { }
})

// ─── Где найти…? ─────────────────────────────────────────────────────────────

const BD_WHERE_SAY = ["Знаю, конечно. Слушай.", "Как не знать - все друг у друга на виду.", "Это недалеко. Объясню."]
const BD_WHERE_DIRS = ["к востоку", "к юго-востоку", "к югу", "к юго-западу", "к западу", "к северо-западу", "к северу", "к северо-востоку"]

/** Где живёт житель: дом, сторона от середины, координаты кровати. */
function bdWhereText(v, s) {
    if (!s.bed) return s.name + " - где живёт, никто толком не знает."
    var house = "доме"
    try {
        var st = global.TFG_STREET.list()[v.settlement], best = null, bd = 1e18
        ;(st && st.buildings || []).forEach(b => {
            var cx = b.x + b.size[0] / 2, cz = b.z + b.size[2] / 2
            var d = Math.pow(cx - s.bed.x, 2) + Math.pow(cz - s.bed.z, 2)
            if (d < bd) { bd = d; best = b }
        })
        if (best) house = { "особняк": "особняке", "трущобы": "хибаре на краю", "форт": "форте", "башня": "башне", "большой": "большом доме",
            "малый": "малом доме" }[best.type] || "доме"
    } catch (e) { }
    var dx = s.bed.x - v.x, dz = s.bed.z - v.z
    var dist = Math.round(Math.sqrt(dx * dx + dz * dz))
    var where = dist < 15 ? "у самой середины поселения" :
        BD_WHERE_DIRS[Math.round(((Math.atan2(dz, dx) * 57.29577951308232) % 360 + 360) % 360 / 45) % 8] + " от середины, шагов " + Math.round(dist / 5) * 5
    return s.name + " (" + (s.role || "житель") + ") живёт в " + house + " " + where + ". Кровать у " + s.bed.x + " " + s.bed.y + " " + s.bed.z + "."
}

function bdWhere(ctx) {
    var w = tkWho(ctx)
    if (!w) return dlgSay(ctx, "Я тут никого не знаю.")
    if (rlTier(w.op.value) === 0) return dlgSay(ctx, gsPick(TK_REFUSE))
    var people = w.v.settlers.filter(s => !s.dead && s.id !== w.s.id)
    people.sort((a, b) => (b.role === "правитель") - (a.role === "правитель"))
    if (!people.length) return dlgSay(ctx, "Кроме меня тут никого.")
    dlgChoice(ctx, "Кого ищешь?", people.slice(0, 12).map(s => ({
        label: s.name + " - " + (s.role === "торговец" && s.trade ? s.trade : s.role || "житель"), hint: "Где живёт",
        run: c => { dlgSay(c, bdPick(BD_WHERE_SAY)); dlgNote(c, bdWhereText(w.v, s)) },
    })))
}

// ─── Подарки и вкусы ─────────────────────────────────────────────────────────

/** Виды вещей: как узнать и что житель говорит, когда любит или терпеть не может. */
const BD_CAT = {
    food: { re: /^(tfc|firmalife|tfc_gourmet):food\/(cooked_|.*bread|.*pie|.*stew|.*soup|.*cake)/, love: "Люблю хорошую горячую еду. Пирог - так и вовсе праздник.", hate: "Терпеть не могу, когда кормят абы чем." },
    sweet: { re: /(honey|jam|chocolate|cookie|sugar|candy)/, love: "Сладкое люблю. Мёд, варенье - ох!", hate: "Сладкое на дух не переношу." },
    drink: { re: /(tfcagedalcohol|beer|cider|mead|vodka|whiskey|rum|sake|wine)/, love: "Хорошая выпивка - вот это подарок.", hate: "Выпивку не люблю. От неё одни беды." },
    jewel: { re: /^tfgui:jewel\//, love: "Украшения люблю. Красивое должно быть красивым.", hate: "Побрякушки - пустое баловство." },
    gem: { re: /(_gem$|^tfc:gem\/|gem_)/, love: "Самоцветы - моя слабость. Как они светятся!", hate: "Камешки блестящие мне ни к чему." },
    metal: { re: /^gtceu:(gold|silver|platinum|rose_gold|sterling_silver|electrum)_(ingot|nugget)$/, love: "Золото и серебро всегда кстати.", hate: "Деньги и слитки мне только душу травят." },
    weapon: { re: /(magistuarmory:|_sword$|tacz:|_spear|_mace)/, love: "Хорошее оружие - лучший подарок.", hate: "Оружие в доме - к беде." },
    tool: { re: /^gtceu:[a-z_]+_(knife|hammer|saw|pickaxe|shovel|hoe|scythe|file|axe|butchery_knife)$/, love: "Добрый инструмент в руки - и работа спорится.", hate: "Инструмент дарить - всё равно что работать заставлять." },
    book: { re: /^minecraft:written_book$/, love: "Книги люблю. Новая книга - как новый друг.", hate: "Книги эти - пыль одна." },
    flower: { re: /(^tfc:plant\/|poppy|dandelion|tulip|rose|lily|orchid|allium)/, love: "Цветы люблю. Простые, полевые.", hate: "Цветы? Траву рвать - дело козье." },
    fur: { re: /(hide|fur|wool|cloth|silk|leather)/, love: "Тёплый мех да хорошая ткань - то, что нужно.", hate: "Шкуры воняют. Не люблю." },
    music: { re: /^immersive_melodies:/, love: "Музыку люблю больше всего на свете.", hate: "Дудки эти - шум один." },
    light: { re: /(candle|lamp|lantern)/, love: "Свечи люблю. Тёплый свет в доме.", hate: "От свечей копоть одна." },
}
const BD_JUNK = /(dirt|cobble|gravel|sand$|:sand|rock\/loose|rock\/raw|loose\/|stick|rotten|clay$|grass$|leaves|_log$|log\/|planks|seeds|bone$|string$|feather|flint)/
const BD_ROLE_LIKES = {
    "правитель": ["jewel", "drink", "gem", "metal", "book"], "крестьянин": ["food", "tool", "sweet", "flower"],
    "охотник": ["weapon", "fur", "food", "drink"], "лесоруб": ["tool", "food", "drink"], "рыцарь": ["weapon", "drink", "metal"],
    "стрелок": ["weapon", "drink", "food"], "дружинник": ["weapon", "food", "drink"], "бард": ["music", "jewel", "drink", "book"],
    "торговец": ["metal", "gem", "jewel", "book"],
}

/** Вкусы жителя: { loves: [2], likes: [3], hates: [1] } - от ремесла и имени, не меняются. */
function bdPrefs(v, s) {
    var all = Object.keys(BD_CAT)
    var seed = String(v.id) + "#" + s.id + "taste"
    var pool = (BD_ROLE_LIKES[s.role] || []).slice()
    var rest = all.filter(c => pool.indexOf(c) < 0).sort((a, b) => bdHash(seed + a) - bdHash(seed + b))
    pool.sort((a, b) => bdHash(seed + a) - bdHash(seed + b))
    var order = pool.concat(rest)
    var loves = [order[0], order[1]]
    var likes = order.slice(2, 5)
    var hates = [rest[rest.length - 1]]
    if (loves.indexOf(hates[0]) >= 0 || likes.indexOf(hates[0]) >= 0) hates = [all.filter(c => loves.indexOf(c) < 0 && likes.indexOf(c) < 0)[0]]
    return { loves: loves, likes: likes, hates: hates }
}

function bdCatOf(st) {
    var id = String(st.id)
    for (var c in BD_CAT) if (BD_CAT[c].re.test(id)) return c
    return BD_JUNK.test(id) ? "junk" : null
}

const BD_GIFT_SAY = {
    love: ["Да это же... как ты узнал?! Спасибо, это лучший подарок!", "Ох! Именно то, о чём я мечтал. Не знаю, как и благодарить."],
    like: ["Спасибо, мне приятно.", "Хорошая вещь, пригодится. Благодарю."],
    plain: ["Спасибо. Не ожидал.", "Ну, спасибо."],
    hate: ["Это... нет. Забери, мне такое не нужно.", "Ты что, смеёшься? Я такое терпеть не могу."],
    junk: ["Зачем мне это? Мусор какой-то.", "Это ты мне подарок принёс? Камень с дороги?"],
    again: ["Ты сегодня уже дарил. Не балуй меня так."],
}
const BD_GIFT_D = { love: 12, like: 6, plain: 2, hate: -6, junk: -3 }

function bdGiftMenu(ctx) {
    var w = tkWho(ctx)
    if (!w) return dlgSay(ctx, "Не надо мне ничего.")
    var inv = ctx.player.inventory, items = [], seen = {}
    for (var i = 0; i < inv.getContainerSize() && items.length < 9; i++) {
        var st = inv.getItem(i)
        if (st.isEmpty()) continue
        var key = String(st.id) + (st.nbt ? String(st.nbt.toString()).length : 0)
        if (seen[key]) continue
        seen[key] = 1
        items.push({ slot: i, id: String(st.id), name: String(st.getHoverName().getString()) })
    }
    if (!items.length) return dlgSay(ctx, "Так у тебя же и нет ничего.")
    dlgChoice(ctx, null, items.map(it => ({
        label: "Подарить: " + it.name, hint: "Один предмет из стопки",
        run: c => bdGive(c, w, it),
    })))
}

function bdGive(ctx, w, it) {
    var st = ctx.player.inventory.getItem(it.slot)
    if (st.isEmpty() || String(st.id) !== it.id) return dlgSay(ctx, "Так где же оно? Нет у тебя ничего.")
    var day = bdDay(ctx.player.level)
    if (!bdOnce(w.v, ctx.player, w.s.id, "gift", day)) return dlgSay(ctx, BD_GIFT_SAY.again[0])
    var cat = bdCatOf(st)
    var pr = bdPrefs(w.v, w.s)
    var kind = cat === "junk" ? "junk" : pr.loves.indexOf(cat) >= 0 ? "love" : pr.likes.indexOf(cat) >= 0 ? "like" : pr.hates.indexOf(cat) >= 0 ? "hate" : "plain"
    if (kind === "hate" || kind === "junk") {
        // нелюбимое и мусор не берёт - вещь остаётся у игрока
        rlNote(w.v, ctx.player, w.s.id, BD_GIFT_D[kind], "неудачный подарок")
        dlgSay(ctx, bdPick(BD_GIFT_SAY[kind]))
    } else {
        st.shrink(1)
        rlNote(w.v, ctx.player, w.s.id, BD_GIFT_D[kind], "подарок")
        dlgSay(ctx, bdPick(BD_GIFT_SAY[kind]))
        if (kind === "love") dlgNote(ctx, "Это его любимое. Он запомнит.")
    }
    try { global.TFG_SETTLERS.save() } catch (e) { }
    bdLog(ctx.player.username + " подарил " + it.id + " жителю " + w.s.name + ": " + kind)
}

// ─── В окно разговора ────────────────────────────────────────────────────────

;(() => {
    if (typeof DLG_NPC_OPTIONS === "undefined") return
    var isSettler = ctx => { try { return ctx.trader.getTags().contains("tfg_settler") } catch (e) { return false } }
    // прежняя «Поговорить» у жителей - разговор по душам (у стражи и гостей - как была)
    ;[DLG_NPC_OPTIONS, typeof DLG_OPTIONS !== "undefined" ? DLG_OPTIONS : null].forEach(list => {
        if (!list) return
        var old = list.filter(o => o.id === "talk")[0]
        if (old && !old.bdWrapped) {
            var oldRun = old.run, oldLabel = old.label, oldHint = old.hint
            old.run = ctx => isSettler(ctx) ? bdTalk(ctx, null) : oldRun(ctx)
            old.label = ctx => isSettler(ctx) ? "Поговорить по душам" : oldLabel(ctx)
            old.hint = ctx => isSettler(ctx) ? "Он заведёт разговор, а ты ответишь. Дружба растёт раз в день." : (oldHint ? oldHint(ctx) : "")
            old.bdWrapped = true
        }
        var add = [
            { id: "bd_gift", label: () => "Подарить…", hint: () => "Вещь из инвентаря. У каждого свои вкусы; мусор обидит. Раз в день.", show: isSettler, run: ctx => bdGiftMenu(ctx) },
            { id: "bd_where", label: () => "Где найти…?", hint: () => "Где живёт кто-то из здешних.", show: isSettler, run: ctx => bdWhere(ctx) },
        ]
        add.forEach(opt => {
            if (list.some(x => x.id === opt.id)) return
            var at = list.findIndex(o => o.id === "leave")
            list.splice(at < 0 ? list.length : at, 0, opt)
        })
    })
})()

ServerEvents.commandRegistry(event => {
    var Commands = event.commands
    event.register(Commands.literal("tfgchat")
        .then(Commands.literal("off").executes(ctx => { ctx.source.getPlayerOrException().persistentData.putBoolean("tfg_chat_off", true); ctx.source.sendSuccess(Text.of("Жители больше не будут окликать."), false); return 1 }))
        .then(Commands.literal("on").executes(ctx => { ctx.source.getPlayerOrException().persistentData.putBoolean("tfg_chat_off", false); ctx.source.sendSuccess(Text.of("Жители снова могут окликать."), false); return 1 })))
})

global.TFG_BONDS = { prefs: (v, s) => bdPrefs(v, s), repLine: ctx => bdRepLine(ctx), where: (v, s) => bdWhereText(v, s) }
