"use strict";
/**
 * Именные NPC фракций: имена, база личностей и память о игроках.
 *
 * Торговцы - личности: имя, фракция, вид, история встреч с каждым игроком. Личность живёт между визитами,
 * может вернуться; если её убили - в следующий раз приходит другой человек с новым именем и пустой памятью.
 * Стражи имён не запоминают: имя выдаётся на визит и забывается.
 *
 * Хранение: JSON в данных сервера (tfg_npc_db), у сущностей - tfg_npc_id и tfg_npc_name в persistentData.
 * API: global.TFG_NPC
 */

var NPC_SERVER = null
var NPC_DB = null

// Имена намеренно разношёрстные, как в RimWorld: смесь языков, без самых заезженных вариантов.
const NPC_GIVEN = [
    "Кайл", "Дэвид", "Пётр", "Арно", "Тобиас", "Ленард", "Милош", "Юхан", "Раду", "Касьян",
    "Эрвин", "Дарек", "Матео", "Виго", "Стефан", "Лукас", "Ансель", "Бран", "Гуннар", "Ежи",
    "Клаус", "Ласло", "Марек", "Нико", "Отто", "Рэй", "Свен", "Тимо", "Устин", "Фелипе",
    "Хенрик", "Цезарь", "Эмиль", "Юстас", "Ярек", "Аарон", "Богдан", "Вальтер", "Герман", "Дитер",
    "Ежен", "Ждан", "Зоран", "Ильмар", "Каспар", "Леон", "Мирко", "Нестор", "Орсо", "Панкрат",
    "Рикард", "Самир", "Торвальд", "Ульрих", "Фарид", "Хьюго", "Чеслав", "Шандор", "Эдгар", "Юлиан",
    "Алистер", "Барух", "Витольд", "Гжегож", "Дамир", "Евсей", "Жером", "Збышек", "Иштван", "Кирилл",
    "Людвиг", "Мартин", "Никлас", "Овидий", "Пабло", "Радим", "Себастьян", "Тадеуш", "Урбан", "Фридрих",
    "Хорхе", "Цвейг", "Эйнар", "Юрген", "Янис", "Адриан", "Борис", "Велько", "Густав", "Далибор",
    "Эмерик", "Ивар", "Конрад", "Лайош", "Матиас", "Норберт", "Оскар", "Прохор", "Ратмир", "Сойер",
    "Тимур", "Уилл", "Флориан", "Харальд", "Эрнест", "Ясон", "Аксель", "Бенце", "Влас", "Гектор",
]
const NPC_SUR = [
    "Реш", "Кальдер", "Вейн", "Мор", "Стрёмберг", "Дож", "Ланге", "Круз", "Тарн", "Верес",
    "Хольм", "Бреннан", "Сокол", "Ферро", "Ланик", "Дрозд", "Хаас", "Марло", "Ковач", "Ржев",
    "Барт", "Гуро", "Дюваль", "Ерш", "Жиров", "Заяц", "Кейн", "Лоцман", "Мешков", "Нагель",
    "Орлик", "Пепел", "Рейн", "Стужа", "Талер", "Урс", "Фогель", "Хват", "Цанге", "Чёрный",
    "Шульц", "Эрк", "Ясень", "Балаш", "Виндт", "Грач", "Дорн", "Ежов", "Зимин", "Ильк",
    "Корвин", "Ларк", "Мюлер", "Нордин", "Ольшан", "Прайс", "Раух", "Свеж", "Торн", "Ундра",
]
const NPC_NICK = [
    "Меченый", "Однорукий", "Тихий", "Рыжий", "Молчун", "Косой", "Долговязый", "Кривой", "Счетовод",
    "Пепельный", "Хромой", "Везучий", "Скупой", "Громкий", "Седой", "Худой", "Гнутый",
]

const NPC_RETURN_CHANCE = 0.55      // с какой вероятностью придёт уже знакомый торговец, если он жив
const NPC_FORGET_DAYS = 240         // личность без визитов дольше этого срока считается ушедшей насовсем
const NPC_MEM_EVENTS = 6            // сколько событий помнит о каждом игроке

function npcLog(text) { try { console.log("[имена] " + text) } catch (e) { } }
function npcPick(list) { return list[Math.floor(Math.random() * list.length)] }

function npcLoad() {
    if (NPC_DB) return NPC_DB
    if (!NPC_SERVER) return { people: {}, seq: 1 }
    var pd = NPC_SERVER.persistentData
    try { NPC_DB = pd.contains("tfg_npc_db") ? JSON.parse(String(pd.getString("tfg_npc_db"))) : {} } catch (e) { NPC_DB = {} }
    if (!NPC_DB.people) NPC_DB.people = {}
    if (!NPC_DB.seq) NPC_DB.seq = 1
    return NPC_DB
}

function npcSave() {
    if (!NPC_SERVER || !NPC_DB) return
    NPC_SERVER.persistentData.putString("tfg_npc_db", JSON.stringify(NPC_DB))
}

function npcDay() {
    try { return Number(TR_Calendars.SERVER.getTotalCalendarDays()) } catch (e) { }
    try { return Math.floor(Number(NPC_SERVER.overworld().getTime()) / 24000) } catch (e) { }
    return 0
}

/** Имя человека: обычно имя и фамилия, иногда имя с прозвищем. */
function npcNewName(taken) {
    for (var i = 0; i < 40; i++) {
        var name = Math.random() < 0.18
            ? npcPick(NPC_GIVEN) + " " + npcPick(NPC_NICK)
            : npcPick(NPC_GIVEN) + " " + npcPick(NPC_SUR)
        if (!taken || !taken[name]) return name
    }
    return npcPick(NPC_GIVEN) + " " + npcPick(NPC_SUR) + " " + (1 + Math.floor(Math.random() * 99))
}

/** Одноразовое имя стража: только имя, без фамилии - запоминать его никто не будет. */
function npcGuardName() { return npcPick(NPC_GIVEN) }

function npcTakenNames() {
    var db = npcLoad()
    var taken = {}
    for (var id in db.people) if (!db.people[id].dead) taken[db.people[id].name] = 1
    return taken
}

/** Личность для торговца: либо возвращается знакомый, либо приходит новый. */
function npcPersonaFor(factionId, kindId) {
    var db = npcLoad()
    var day = npcDay()
    var known = []
    for (var id in db.people) {
        var p = db.people[id]
        if (p.dead || p.faction !== factionId || p.kind !== kindId) continue
        if (day - (p.lastDay || 0) > NPC_FORGET_DAYS) continue
        known.push(p)
    }
    if (known.length && Math.random() < NPC_RETURN_CHANCE) {
        var old = known[Math.floor(Math.random() * known.length)]
        old.visits = (old.visits || 0) + 1
        old.lastDay = day
        npcSave()
        return old
    }
    var nid = "n" + (db.seq++)
    var person = {
        id: nid, name: npcNewName(npcTakenNames()), faction: factionId, kind: kindId,
        born: day, lastDay: day, visits: 1, dead: false, mem: {},
    }
    db.people[nid] = person
    npcSave()
    npcLog("новый торговец " + person.name + " (" + factionId + "/" + kindId + ")")
    return person
}

function npcPerson(id) {
    if (!id) return null
    var db = npcLoad()
    return db.people[String(id)] || null
}

/** Личность по сущности (торговец); у стражей её нет. */
function npcPersonOf(e) {
    try { return e.persistentData.contains("tfg_npc_id") ? npcPerson(String(e.persistentData.getString("tfg_npc_id"))) : null } catch (err) { return null }
}

function npcNameOf(e) {
    try { if (e.persistentData.contains("tfg_npc_name")) return String(e.persistentData.getString("tfg_npc_name")) } catch (err) { }
    var p = npcPersonOf(e)
    return p ? p.name : null
}

function npcMemOf(person, player) {
    if (!person || !player) return null
    person.mem = person.mem || {}
    var key = String(player.uuid)
    if (!person.mem[key]) person.mem[key] = { name: String(player.username), met: 0, lastDay: -1, deals: 0, spent: 0, events: [] }
    person.mem[key].name = String(player.username)
    return person.mem[key]
}

/** Записать в память торговца событие про игрока: ключ нужен, чтобы одно и то же не копилось. */
function npcRemember(person, player, key, text) {
    var m = npcMemOf(person, player)
    if (!m) return
    m.events = m.events.filter(ev => ev.k !== key)
    m.events.push({ k: key, t: text, d: npcDay() })
    while (m.events.length > NPC_MEM_EVENTS) m.events.shift()
    npcSave()
}

/** Отметить встречу; возвращает, сколько дней прошло с прошлой (-1 - видятся впервые). */
function npcNoteMeeting(person, player) {
    var m = npcMemOf(person, player)
    if (!m) return -1
    var day = npcDay()
    var gap = m.lastDay < 0 ? -1 : day - m.lastDay
    m.met++
    m.lastDay = day
    npcSave()
    return gap
}

function npcNoteDeal(person, player, value) {
    var m = npcMemOf(person, player)
    if (!m) return
    m.deals++
    m.spent += Math.max(0, Math.round(value))
    if (value >= 500) npcRemember(person, player, "bigdeal", "крупная сделка на " + Math.round(value) + " медяков")
    else npcSave()
}

/** Личность мертва: в следующий раз придёт другой человек. */
function npcKilled(e) {
    var p = npcPersonOf(e)
    if (!p || p.dead) return
    p.dead = true
    p.diedDay = npcDay()
    npcSave()
    npcLog(p.name + " погиб")
}

global.TFG_NPC = {
    personaFor: (f, k) => npcPersonaFor(f, k),
    person: id => npcPerson(id),
    personOf: e => npcPersonOf(e),
    nameOf: e => npcNameOf(e),
    guardName: () => npcGuardName(),
    remember: (p, pl, k, t) => npcRemember(p, pl, k, t),
    noteMeeting: (p, pl) => npcNoteMeeting(p, pl),
    noteDeal: (p, pl, v) => npcNoteDeal(p, pl, v),
    memOf: (p, pl) => npcMemOf(p, pl),
    killed: e => npcKilled(e),
}

ServerEvents.tick(event => {
    if (!NPC_SERVER) {
        NPC_SERVER = event.server
        npcLoad()
    }
})

EntityEvents.death(event => {
    try {
        var e = event.entity
        if (!e || !e.persistentData || !e.persistentData.contains("tfg_npc_id")) return
        npcKilled(e)
    } catch (err) { npcLog("смерть: " + err) }
})

ServerEvents.commandRegistry(event => {
    var Commands = event.commands
    var Arguments = event.arguments
    try {
        event.register(Commands.literal("tfgnpc")
            .requires(s => s.hasPermission(2))
            .executes(ctx => {
                if (!NPC_SERVER) NPC_SERVER = ctx.source.getServer()
                var db = npcLoad()
                var rows = []
                for (var id in db.people) {
                    var p = db.people[id]
                    var mem = 0
                    for (var k in p.mem || {}) mem++
                    rows.push((p.dead ? "§8" : "§f") + p.name + " §7" + p.faction + "/" + p.kind + ", визитов " + p.visits +
                        ", знает игроков " + mem + (p.dead ? ", погиб" : ""))
                }
                ctx.source.sendSuccess(Text.of(rows.length ? rows.join("\n") : "§7база имён пуста"), false)
                return 1
            }))

    } catch (err) {
        console.error("[npc_names] ошибка регистрации команд: " + err)
    }
})
