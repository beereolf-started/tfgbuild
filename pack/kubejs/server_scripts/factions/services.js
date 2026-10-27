"use strict";
/**
 * Услуги фракций, которые заказывают в разговоре (factions/dialogue.js):
 *   1. позвать нужного торговца - придёт через 1-4 дня и не тратит обычный счётчик визитов;
 *   2. нанять охрану - отряд приходит к базе и сутки живёт своим; заплатили старшему - сразу встают в караул
 *      на неделю, не заплатили - уходят;
 *   3. перелёт - дирижабль с пилотом и охраной везёт игрока в любую точку и забирает через оговорённый срок.
 *
 * Хранение: планы и рейсы - JSON в данных сервера (tfg_svc_plans, tfg_svc_flights),
 * наёмники - обычная запись визита с меткой merc (её ведёт svcMercTick через gsVisitTick).
 */

var SVC_SERVER = null
var SVC_PLANS = null                // отложенные приходы торговцев
var SVC_FLIGHTS = null              // рейсы дирижаблей
var SVC_FLY_RT = {}                 // рантайм пилотирования: id рейса -> gsCraftRt

const SVC_SUMMON_COOLDOWN = 6       // дней между заказами торговца у одной фракции
const SVC_SUMMON_MIN = 1            // через сколько дней самое раннее придёт заказанный
const SVC_SUMMON_MAX = 4
const SVC_MERC_DAYS = 7             // срок службы наёмников с момента оплаты
const SVC_MERC_OFFER = 24000        // сутки отряд стоит без дела и ждёт уговора, потом уходит
const SVC_MERC_RANGE = 56           // радиус охраны вокруг базы
const SVC_MERC_LEASH = 72           // дальше отряд не гонится
const SVC_MERC_STUCK = 300          // тиков на месте - считается застрявшим
const SVC_FLY_WAIT = 12000          // сколько борт ждёт посадки игрока
const SVC_FLY_STAY = 24000          // сутки стоянки в точке высадки
const SVC_FLY_PRICE_BASE = 60          // перелёт подешевел вдвое
const SVC_FLY_PRICE_PER_BLOCK = 0.025
const SVC_FLY_PRICE_PER_DAY = 30

function svcLog(text) { try { console.log("[услуги] " + text) } catch (e) { } }
function svcErr(where, err) { try { console.error("[услуги] " + where + ": " + err) } catch (e) { } }

function svcDay() {
    try { return Number(TR_Calendars.SERVER.getTotalCalendarDays()) } catch (e) { return 0 }
}

function svcPlayerByUuid(uuid) {
    var found = null
    try { SVC_SERVER.players.forEach(p => { if (String(p.uuid) === String(uuid)) found = p }) } catch (e) { }
    return found
}

function svcState(key, fallback) {
    var pd = SVC_SERVER.persistentData
    try { return pd.contains(key) ? JSON.parse(String(pd.getString(key))) : fallback } catch (e) { return fallback }
}

function svcPlans() { return SVC_PLANS || (SVC_PLANS = svcState("tfg_svc_plans", [])) }
function svcFlights() { return SVC_FLIGHTS || (SVC_FLIGHTS = svcState("tfg_svc_flights", [])) }
function svcSavePlans() { SVC_SERVER.persistentData.putString("tfg_svc_plans", JSON.stringify(svcPlans())) }
function svcSaveFlights() { SVC_SERVER.persistentData.putString("tfg_svc_flights", JSON.stringify(svcFlights())) }

function svcBase(player) {
    var b = null
    try { b = global.TFG_SETTLEMENTS.baseFor(player) } catch (e) { }
    if (b) return { x: Math.floor(b.x), y: Math.floor(b.y), z: Math.floor(b.z) }
    return { x: Math.floor(player.getX()), y: Math.floor(player.getY()), z: Math.floor(player.getZ()) }
}

function svcTier(player) {
    try { return Math.max(1, Math.min(10, Number(global.TFG_PLAYER_TIER(player)) || 1)) } catch (e) { return 1 }
}

// ─── 1. Заказ торговца ───────────────────────────────────────────────────────

function svcSummonKey(player, factionId) { return "tfg_svc_summon_" + String(player.uuid) + "_" + factionId }

/** Сколько дней ждать до следующего заказа у этой фракции; 0 - можно заказывать. */
function svcSummonWait(player, factionId) {
    if (!SVC_SERVER) SVC_SERVER = player.getServer()
    var pd = SVC_SERVER.persistentData
    var k = svcSummonKey(player, factionId)
    if (!pd.contains(k)) return 0
    return Math.max(0, Number(pd.getLong(k)) + SVC_SUMMON_COOLDOWN - svcDay())
}

/** Заказ у торговца: своего человека нужного ремесла пришлют через 1-4 дня. */
function svcRequestTrader(ctx, kindId) {
    var player = ctx.player
    if (!SVC_SERVER) SVC_SERVER = player.getServer()
    var wait = svcSummonWait(player, ctx.faction)
    if (wait > 0) { dlgSay(ctx, "Мы уже послали весточку. Подожди ещё " + wait + " дн."); return }
    var kind = global.TFG_TRADE_GOODS.kind(kindId)
    if (!kind) { dlgSay(ctx, "Такого ремесла у нас нет."); return }
    var days = SVC_SUMMON_MIN + Math.floor(Math.random() * (SVC_SUMMON_MAX - SVC_SUMMON_MIN + 1))
    var base = svcBase(player)
    svcPlans().push({
        type: "trader", faction: ctx.faction, kind: kindId, tier: svcTier(player), day: svcDay() + days,
        dim: String(player.level.getDimension()), x: base.x, y: base.y, z: base.z, player: String(player.uuid),
    })
    svcSavePlans()
    SVC_SERVER.persistentData.putLong(svcSummonKey(player, ctx.faction), svcDay())
    dlgSay(ctx, "Передам своим. " + kind.name + " будет у вас дня через " + days + ".")
    try { global.TFG_NPC.remember(ctx.person, player, "favor", "я присылал сюда нужного человека по просьбе") } catch (e) { }
    svcLog(player.username + ": заказан " + kind.name + " (" + ctx.faction + ") на день " + (svcDay() + days))
}

function svcPlansTick() {
    var plans = svcPlans()
    if (!plans.length) return
    var today = svcDay()
    var left = []
    var changed = false
    plans.forEach(p => {
        if (today < p.day) { left.push(p); return }
        changed = true
        try {
            var level = SVC_SERVER.getLevel(p.dim) || SVC_SERVER.overworld()
            if (p.type === "merc") {
                var who = svcPlayerByUuid(p.player) || { uuid: p.player, username: p.playerName || "?" }
                var mv = svcMercSpawn(level, { x: p.x, y: p.y, z: p.z }, p.faction, p.tier, p.size, who, p.price)
                var pl = svcPlayerByUuid(p.player)
                if (!mv) { if (today - p.day < 3) left.push(p) }
                else if (pl) pl.tell(Text.of("§6[Охрана] §fОтряд от правителя подходит к вашей базе. Плата - старшему: " + p.price + " " + global.TFG_COINS.unit + "."))
                return
            }
            var err = global.TFG_GUESTS.visit(level, { x: p.x, y: p.y, z: p.z }, p.faction, p.kind, p.tier)
            var player = svcPlayerByUuid(p.player)
            if (err) {
                svcLog("заказ не вышел: " + err)
                if (player) player.tell(Text.of("§7Заказанный торговец не смог прийти: " + err))
                if (today - p.day < 3) { left.push(p); changed = true }      // попробуем ещё раз завтра
            } else if (player) {
                player.tell(Text.of("§6[Караван] §fЗаказанный вами торговец подходит к базе."))
            }
        } catch (e) { svcErr("приход заказанного", e) }
    })
    if (changed) { SVC_PLANS = left; svcSavePlans() }
}

// ─── 2. Наёмная охрана ───────────────────────────────────────────────────────

// охрана подешевела: неделя обычного отряда - от 120 монет
function svcGuardPriceTier(tier) { return Math.round(120 * Math.pow(1.4, Math.max(1, tier) - 1)) }
function svcGuardPrice(player) { return svcGuardPriceTier(svcTier(player)) }
/** Цена недели за n бойцов выучки tier (обычный отряд - svcSquadSize бойцов). */
function svcGuardPriceFor(tier, n) { return Math.round(svcGuardPriceTier(tier) * n / svcSquadSize(tier)) }

/** Отряд от правителя поселения: придёт в назначенный день (plans, тип merc). */
function svcPlanGuards(player, factionId, tier, size, days) {
    if (!SVC_SERVER) SVC_SERVER = player.getServer()
    var base = svcBase(player)
    svcPlans().push({
        type: "merc", faction: factionId, tier: tier, size: size, price: svcGuardPriceFor(tier, size), day: svcDay() + days,
        dim: String(player.level.getDimension()), x: base.x, y: base.y, z: base.z, player: String(player.uuid), playerName: String(player.username),
    })
    svcSavePlans()
    svcLog(player.username + ": отряд " + factionId + " (" + size + " бойцов, тир " + tier + ") на день " + (svcDay() + days))
}

function svcGuardsPlanned(player) { return svcPlans().some(p => p.type === "merc" && p.player === String(player.uuid)) }

function svcSquadSize(tier) { return Math.max(3, Math.min(8, 2 + Math.ceil(tier / 1.5))) }

/** Есть ли у игрока уже отряд этой фракции. */
function svcMercOf(player) {
    var found = null
    try {
        var visits = gsLoad()
        for (var id in visits) {
            var v = visits[id]
            if (v.merc && v.employer === String(player.uuid)) found = v
        }
    } catch (e) { }
    return found
}

function svcGuardsAvailable(ctx) {
    if (ctx.faction === "bandits") return "Разбойники охраной не подрабатывают."
    if (svcMercOf(ctx.player)) return "Наш отряд уже у вас."
    return true
}

/** Заказ отряда: денег вперёд не берут - платить будете старшему, когда бойцы придут. */
function svcHireGuards(ctx) {
    var player = ctx.player
    if (!SVC_SERVER) SVC_SERVER = player.getServer()
    var check = svcGuardsAvailable(ctx)
    if (check !== true) { dlgSay(ctx, String(check)); return }
    var tier = svcTier(player)
    dlgSay(ctx, gsPick(DLG_ASK_MASTER))
    var v = svcMercSpawn(player.level, svcBase(player), ctx.faction, tier, svcSquadSize(tier), player)
    if (!v) { dlgSay(ctx, "Свободных людей сейчас нет."); return }
    dlgSay(ctx, "Люди подойдут. Сутки постоят без дела: сговоришься со старшим и заплатишь - встанут в караул, " +
        "нет - уйдут своей дорогой. Неделя службы стоит " + svcGuardPrice(player) + " " + global.TFG_COINS.unit + ".")
    try { global.TFG_NPC.remember(ctx.person, player, "guards", "я присылал сюда своих бойцов в охрану") } catch (e) { }
    dlgClose(player)
}

/** Старший отряда: боец с ролью bodyguard, к нему и обращаются с деньгами. */
function svcSquadLeader(v) {
    var found = null
    v.guards.forEach(u => {
        if (found) return
        var g = gsEntity(v, u)
        if (!g) return
        try { if (String(g.persistentData.getString("tfg_guest_role")) === "bodyguard") found = g } catch (e) { }
    })
    if (!found) {
        for (var i = 0; i < v.guards.length && !found; i++) found = gsEntity(v, v.guards[i])
    }
    return found
}

/** Отряд наёмников по сущности бойца (для разговора со старшим). */
function svcMercVisitOf(e) {
    try {
        var id = String(e.persistentData.getString("tfg_guest_visit"))
        var v = gsLoad()[id]
        return v && v.merc ? v : null
    } catch (err) { return null }
}

/** Оплата старшему: отряд немедленно берётся за работу и служит неделю. */
function svcPaySquad(player, v) {
    if (!SVC_SERVER) SVC_SERVER = player.getServer()
    if (v.paid) return "Нам уже уплачено."
    if (String(player.uuid) !== v.employer) return "Мы пришли не к тебе."
    var price = v.price || svcGuardPrice(player)
    var have = 0
    try { have = Number(global.TFG_COINS.verifiedTotal(player)) || 0 } catch (e) { }
    if (have < price) return "Не хватает " + (price - have) + " " + global.TFG_COINS.unit + "."
    if (!global.TFG_COINS.pay(player, price)) return "Монет не хватает."
    var now = gsNow(player.level)
    v.paid = true
    v.paidAt = now
    v.until = now + SVC_MERC_DAYS * 24000
    gsSave()
    try { global.TFG_FACTIONS.addRep(player, v.faction, 3, "наём охраны") } catch (e) { }
    svcLog(player.username + ": отряду " + v.id + " уплачено " + price + ", служба до " + v.until)
    return true
}

/** Отряд наёмников: обычная запись визита с меткой merc, чтобы работали сохранение и поиск сущностей. */
function svcMercSpawn(level, center, factionId, tier, size, player, price) {
    if (!GS_SERVER) GS_SERVER = level.getServer()
    var visits = gsLoad()
    var now = gsNow(level)
    var id = "m" + now + "_" + Math.floor(Math.random() * 1000)
    var arrive = gsNearestStand(level, center.x, center.z, 24)
    var ang = Math.random() * 6.283185307179586
    var sx = Math.floor(arrive.x + Math.cos(ang) * 40)
    var sz = Math.floor(arrive.z + Math.sin(ang) * 40)
    var start = gsNearestStand(level, sx, sz, 16)
    var v = {
        id: id, faction: factionId, tier: tier, dim: String(level.getDimension()), transport: "foot",
        center: { x: center.x, y: center.y, z: center.z }, arrive: arrive, phase: "stay", since: now,
        until: now + SVC_MERC_OFFER, trader: null, guards: [], crafts: [], carts: [], horses: [],
        hostile: null, raid: false, merc: true, employer: String(player.uuid), employerName: String(player.username),
        paid: false, kindName: "Наёмники", price: price || null,
    }
    visits[id] = v
    var guards = []
    for (var i = 0; i < size; i++) {
        var a = i * 6.283185307179586 / size
        var g = gsSpawnGuard(v, level, start.x + Math.cos(a) * 2.5, start.y, start.z + Math.sin(a) * 2.5, i)
        if (g) { guards.push(g); v.guards.push(String(g.uuid)); GS_ENT[String(g.uuid)] = g }
    }
    if (!guards.length) {
        delete visits[id]
        gsSave()
        return null
    }
    v.startGuards = guards.length
    gsSave()
    svcLog(player.username + ": нанято " + guards.length + " бойцов фракции " + factionId + " (тир " + tier + ")")
    return v
}

/** Виден ли гость хоть одному игроку: телепортировать отставших можно только вне поля зрения. */
function svcSeen(level, e) {
    var seen = false
    try {
        GS_SERVER.players.forEach(p => {
            if (seen || String(p.level.getDimension()) !== String(level.getDimension())) return
            var dx = e.getX() - p.getX(), dy = e.getY() - p.getY(), dz = e.getZ() - p.getZ()
            var d2 = dx * dx + dy * dy + dz * dz
            if (d2 > 64 * 64) return
            if (d2 < 12 * 12) { seen = true; return }
            var look = p.getLookAngle()
            var len = Math.sqrt(d2) || 1
            var dot = (Number(look.x) * dx + Number(look.y) * dy + Number(look.z) * dz) / len
            if (dot > 0.55) seen = true
        })
    } catch (err) { }
    return seen
}

/** Достижим ли враг: есть путь или хотя бы прямая видимость до середины хитбокса. */
function svcReachable(g, t) {
    try {
        if (Math.abs(t.getY() - g.getY()) > 16) return false
    } catch (e) { }
    var los = false
    try { los = !!g.hasLineOfSight(t) } catch (e) {
        try { los = !!g.canSee(t) } catch (e2) { los = false }
    }
    if (los) return true
    try {
        var path = g.getNavigation().createPath(t, 1)
        if (path && path.canReach()) return true
    } catch (e) { }
    return false
}

function svcMercPatrolSpot(v, level, now, i, n) {
    var a = (now / 600 + i * 6.283185307179586 / Math.max(1, n)) % 6.283185307179586
    var r = SVC_MERC_RANGE * 0.6
    var x = v.center.x + Math.cos(a) * r
    var z = v.center.z + Math.sin(a) * r
    return { x: x, y: gsSurface(level, x, z), z: z }
}

/**
 * Наёмники: сутки обживаются (занятия как у гостей), дальше патрулируют базу и группой бьют достижимых врагов.
 * Бой уже отработал в gsVisitTick - здесь снимаем цели, до которых не дойти, и правим строй.
 */
function svcMercTick(v, level, now, guards, rt, fighting, enemies) {
    if (!guards.length) {
        if (now > v.until) gsEndVisit(v, "наёмников не осталось")
        return
    }
    var player = svcPlayerByUuid(v.employer)
    // не уплачено за сутки - уходят; уплачено - служат неделю с часа оплаты
    if (now >= v.until) {
        if (player) player.tell(Text.of(v.paid
            ? "§7Срок службы отряда фракции " + gsFactionName(v.faction) + " вышел, бойцы уходят."
            : "§7Бойцы фракции " + gsFactionName(v.faction) + " не дождались уговора и уходят."))
        guards.forEach(g => gsCalm(g))
        gsSetPhase(v, "board", now)
        v.merc = false                                        // дальше уходят обычным порядком
        gsSave()
        return
    }
    if (!v.paid && player && !v.warned && v.until - now < 2400) {
        v.warned = true
        gsSave()
        player.tell(Text.of("§7Старший отряда собирает людей: хотите нанять - поговорите с ним (ПКМ) сейчас."))
    }
    // пока не уплачено, бойцы живут своим: занятия, костры, разговоры - как у гостей
    var passive = !v.paid
    guards.forEach((g, i) => {
        var key = String(g.uuid)
        if (fighting[key]) return
        // цель, до которой не добраться (под землёй, за стеной) - не ломаем об неё ИИ
        var target = null
        try { target = g.getTarget() } catch (e) { }
        if (target && !svcReachable(g, target)) {
            try { g.setTarget(null) } catch (e) { }
            return
        }
        if (passive) {
            if (!rt.acts[key]) gsActTick(v, level, g, rt, now)
            return
        }
        // патруль: медленно обходим базу по кольцу, каждый по своей дуге
        var spot = svcMercPatrolSpot(v, level, now, i, guards.length)
        var d2 = gsDist2(g, spot.x, spot.z)
        if (d2 > 9 && g.getNavigation().isDone()) gsWalk(g, spot.x, spot.y, spot.z, 0.85)
        // отстал или застрял - подтягиваем к отряду, но только когда никто не смотрит
        var away2 = gsDist2(g, v.center.x, v.center.z)
        if (away2 > SVC_MERC_LEASH * SVC_MERC_LEASH) {
            rt.stuckAt = rt.stuckAt || {}
            rt.stuckAt[key] = (rt.stuckAt[key] || 0) + 20
            if (rt.stuckAt[key] > SVC_MERC_STUCK && !svcSeen(level, g)) {
                gsTp(level, g, spot.x, spot.y, spot.z)
                rt.stuckAt[key] = 0
                svcLog(v.id + ": боец подтянут к отряду")
            }
        } else if (rt.stuckAt) rt.stuckAt[key] = 0
    })
}

// ─── 3. Перелёт дирижаблем ───────────────────────────────────────────────────

function svcFlightOf(player) {
    return svcFlights().filter(f => f.player === String(player.uuid))[0] || null
}

function svcFlightAvailable(ctx) {
    if (ctx.faction === "bandits") return "У этих в небе только налёты."
    var air = ctx.faction === "wind" || ctx.tier >= 4
    if (!air) return "У здешних людей нет борта - спроси у Торговцев ветром."
    if (svcFlightOf(ctx.player)) return "Ваш рейс уже в работе."
    return true
}

function svcFlightPrice(dist, days) {
    return Math.round(SVC_FLY_PRICE_BASE + dist * SVC_FLY_PRICE_PER_BLOCK + Math.max(0, days) * SVC_FLY_PRICE_PER_DAY)
}

function svcFlightMenu(ctx, delay) {
    var player = ctx.player
    if (!SVC_SERVER) SVC_SERVER = player.getServer()
    if (delay === undefined) dlgSay(ctx, gsPick(DLG_ASK_MASTER))   // торговец спрашивает у своих
    SVC_SERVER.persistentData.putString("tfg_svc_fly_offer_" + String(player.uuid),
        JSON.stringify({ faction: ctx.faction, until: Number(player.level.getTime()) + 6000, person: ctx.person ? ctx.person.id : null, delay: delay || 0 }))
    dlgSay(ctx, "Скажи, куда лететь и на сколько дней тебя там оставить.")
    dlgTell(player, [{ text: "  ▸ ", color: "gold" },
        { text: "Назвать точку: /tfgflight <x> <z> <дней>", color: "yellow", underlined: true,
            clickEvent: { action: "suggest_command", value: "/tfgflight " + Math.floor(player.getX()) + " " + Math.floor(player.getZ()) + " 3" },
            hoverEvent: { action: "show_text", contents: "Цена: " + SVC_FLY_PRICE_BASE + " + " + SVC_FLY_PRICE_PER_BLOCK +
                " за блок пути и " + SVC_FLY_PRICE_PER_DAY + " за день ожидания." } }])
    dlgTell(player, { text: "  Борт идёт под облаками: ни горгульи, ни сирены его не тронут.", color: "dark_gray", italic: true })
}

/** Заказ рейса командой: /tfgflight <x> <z> <дней>. */
function svcOrderFlight(player, dx, dz, days) {
    if (!SVC_SERVER) SVC_SERVER = player.getServer()
    var raw = null
    try {
        var k = "tfg_svc_fly_offer_" + String(player.uuid)
        if (SVC_SERVER.persistentData.contains(k)) raw = JSON.parse(String(SVC_SERVER.persistentData.getString(k)))
    } catch (e) { }
    if (!raw || Number(player.level.getTime()) > raw.until) { player.tell(Text.of("§7Сначала договоритесь о перелёте с торговцем.")); return }
    if (svcFlightOf(player)) { player.tell(Text.of("§7Ваш рейс уже в работе.")); return }
    days = Math.max(0, Math.min(14, Math.floor(days)))
    var home = svcBase(player)
    var dist = Math.sqrt(Math.pow(dx - home.x, 2) + Math.pow(dz - home.z, 2))
    if (dist < 200) { player.tell(Text.of("§7Слишком близко - дойдёте пешком.")); return }
    var price = svcFlightPrice(dist, days)
    if (!global.TFG_COINS.pay(player, price)) {
        player.tell(Text.of("§7Рейс стоит " + price + " " + global.TFG_COINS.unit + " - не хватает монет."))
        return
    }
    var delay = Math.max(0, Math.floor(raw.delay || 0))
    var f = {
        id: "f" + Number(player.level.getTime()) + "_" + Math.floor(Math.random() * 1000),
        player: String(player.uuid), faction: raw.faction, dim: String(player.level.getDimension()),
        home: home, dest: { x: Math.floor(dx), z: Math.floor(dz) }, days: days, price: price,
        phase: delay ? "planned" : "coming", startDay: svcDay() + delay, at: Number(player.level.getTime()), craft: null, crew: [],
    }
    svcFlights().push(f)
    svcSaveFlights()
    player.tell(Text.of("§9[Рейс] §f" + (delay ? "Борт вылетит за вами через " + delay + " дн." : "Борт вылетел за вами.") + " Цена " + price + " " + global.TFG_COINS.unit +
        ", расстояние " + Math.round(dist) + " блоков, ожидание " + days + " дн."))
    svcLog(player.username + ": рейс на " + f.dest.x + " " + f.dest.z + " за " + price)
}

function svcFlightLevel(f) {
    try { return SVC_SERVER.getLevel(f.dim) || SVC_SERVER.overworld() } catch (e) { return SVC_SERVER.overworld() }
}

function svcFlightCraft(f) {
    if (!f.craft) return null
    var level = svcFlightLevel(f)
    try {
        var e = level.getEntity(f.craft)
        return e && e.isAlive() ? e : null
    } catch (err) { return null }
}

/** Борт с пилотом и одним охранником появляется в стороне и идёт на посадку к точке. */
function svcSpawnCraft(f, level, near, land) {
    var ang = Math.random() * 6.283185307179586
    var sx = Math.floor(near.x + Math.cos(ang) * 120)
    var sz = Math.floor(near.z + Math.sin(ang) * 120)
    var sy = Math.max(gsSurface(level, sx, sz) + 30, 90)
    var craft = airSummon(level, "immersive_aircraft:cargo_airship", sx, sy, sz, ["tfg_npc", "tfg_svc_craft"])
    if (!craft) return null
    try { airRefuel(craft) } catch (e) { }
    f.craft = String(craft.uuid)
    // экипаж: пилот и охранник живут записью визита наёмников с нулевым сроком - им нужен только внешний вид
    var v = { id: f.id, faction: f.faction, tier: 5, dim: f.dim }
    f.crew = []
    var pilot = gsSpawnGuard(v, level, craft.getX(), craft.getY(), craft.getZ(), 0)
    if (pilot) {
        try { pilot.persistentData.putString("tfg_npc_name", global.TFG_NPC.guardName()) } catch (e) { }
        airMount(pilot, craft)
        f.crew.push(String(pilot.uuid))
    }
    var guard = gsSpawnGuard(v, level, craft.getX(), craft.getY(), craft.getZ(), 2)
    if (guard) { airMount(guard, craft); f.crew.push(String(guard.uuid)) }
    var spot = aiFindLanding(level, land.x, land.z, 3) || { x: land.x, y: gsSurface(level, land.x, land.z), z: land.z }
    var c = gsCraftRt(craft, "cargo_airship")
    c.goal = { x: spot.x, y: spot.y, z: spot.z, land: true }
    SVC_FLY_RT[f.id] = c
    f.spot = { x: spot.x, y: spot.y, z: spot.z }
    return craft
}

function svcCrewClear(f) {
    var level = svcFlightLevel(f)
    ;(f.crew || []).forEach(u => {
        try {
            var e = level.getEntity(u)
            if (e) e.discard()
        } catch (err) { }
    })
    f.crew = []
    var craft = svcFlightCraft(f)
    if (craft) craft.discard()
    f.craft = null
    delete SVC_FLY_RT[f.id]
}

function svcFlightDone(f, msg) {
    svcCrewClear(f)
    var player = svcPlayerByUuid(f.player)
    if (player && msg) player.tell(Text.of("§9[Рейс] §f" + msg))
    SVC_FLIGHTS = svcFlights().filter(x => x.id !== f.id)
    svcSaveFlights()
}

function svcRt(f) {
    var c = SVC_FLY_RT[f.id]
    if (c && c.vehicle && c.vehicle.isAlive()) return c
    var craft = svcFlightCraft(f)
    if (!craft) return null
    c = gsCraftRt(craft, "cargo_airship")
    if (f.spot) c.goal = { x: f.spot.x, y: f.spot.y, z: f.spot.z, land: true }
    SVC_FLY_RT[f.id] = c
    return c
}

function svcAboard(craft, player) {
    try {
        var list = craft.getPassengers()
        for (var i = 0; i < list.size(); i++) if (String(list.get(i).uuid) === String(player.uuid)) return true
    } catch (e) { }
    return false
}

function svcFlightTick(f, now) {
    var level = svcFlightLevel(f)
    var player = svcPlayerByUuid(f.player)
    // заказан на другой день - ждём его
    if (f.phase === "planned") {
        if (svcDay() < (f.startDay || 0)) return
        f.phase = "coming"
        f.at = now
        svcSaveFlights()
        if (player) player.tell(Text.of("§9[Рейс] §fСегодня за вами вылетел заказанный борт."))
        return
    }
    if (f.phase === "coming" || f.phase === "pickup_coming") {
        var craft = svcFlightCraft(f)
        if (!craft) {
            var near = f.phase === "coming" ? f.home : (player ? { x: player.getX(), z: player.getZ() } : f.dest)
            var land = f.phase === "coming" ? f.home : near
            if (!svcSpawnCraft(f, level, near, land)) { svcFlightDone(f, "борт не смог вылететь, деньги пропали в дороге"); return }
            svcSaveFlights()
            return
        }
        var c = svcRt(f)
        if (!c) return
        if (c.landed) {
            f.phase = f.phase === "coming" ? "waiting" : "pickup_waiting"
            f.at = now
            if (player) player.tell(Text.of("§9[Рейс] §fБорт сел" + (f.phase === "waiting" ? " у базы" : " рядом с вами") + ". Садитесь, ждём недолго."))
            svcSaveFlights()
        }
        return
    }
    if (f.phase === "waiting" || f.phase === "pickup_waiting") {
        var craft2 = svcFlightCraft(f)
        if (!craft2) { svcFlightDone(f, "борт потерян"); return }
        if (player && svcAboard(craft2, player)) {
            var c2 = svcRt(f)
            var to = f.phase === "waiting" ? f.dest : f.home
            var spot = aiFindLanding(level, to.x, to.z, 3) || { x: to.x, y: gsSurface(level, to.x, to.z), z: to.z }
            f.spot = { x: spot.x, y: spot.y, z: spot.z }
            c2.landed = false
            c2.mode = "ai"
            c2.goal = { x: spot.x, y: spot.y, z: spot.z, land: true }
            f.phase = f.phase === "waiting" ? "flying" : "returning"
            f.at = now
            player.tell(Text.of("§9[Рейс] §fВзлетаем. Идём под облаками."))
            svcSaveFlights()
            return
        }
        if (now - f.at > SVC_FLY_WAIT) {
            if (f.phase === "waiting") { svcFlightDone(f, "борт не дождался вас и ушёл."); return }
            svcCrewClear(f)
            f.phase = "parked"
            f.at = now
            f.pickupDay = svcDay() + Math.max(1, f.days)
            svcSaveFlights()
        }
        return
    }
    if (f.phase === "flying" || f.phase === "returning") {
        var craft3 = svcFlightCraft(f)
        if (!craft3) { svcFlightDone(f, "борт потерян в пути"); return }
        var c3 = svcRt(f)
        if (!c3) return
        if (c3.landed) {
            if (f.phase === "returning") { svcFlightDone(f, "прибыли. Спасибо, что выбрали нас."); return }
            f.phase = "landed"
            f.at = now
            if (player) player.tell(Text.of("§9[Рейс] §fСели. Борт постоит сутки, потом уйдёт и вернётся через " + f.days + " дн."))
            svcSaveFlights()
        }
        return
    }
    if (f.phase === "landed") {
        var craft4 = svcFlightCraft(f)
        if (!craft4) { svcFlightDone(f, "борт потерян на стоянке"); return }
        if (player && svcAboard(craft4, player)) {                     // передумал - везём домой сразу
            var c4 = svcRt(f)
            var spot2 = aiFindLanding(level, f.home.x, f.home.z, 3) || { x: f.home.x, y: gsSurface(level, f.home.x, f.home.z), z: f.home.z }
            f.spot = { x: spot2.x, y: spot2.y, z: spot2.z }
            c4.landed = false
            c4.mode = "ai"
            c4.goal = { x: spot2.x, y: spot2.y, z: spot2.z, land: true }
            f.phase = "returning"
            f.at = now
            svcSaveFlights()
            return
        }
        if (now - f.at > SVC_FLY_STAY) {
            svcCrewClear(f)
            f.phase = "parked"
            f.at = now
            f.pickupDay = svcDay() + Math.max(1, f.days)
            if (player) player.tell(Text.of("§9[Рейс] §fБорт ушёл. Вернётся за вами через " + f.days + " дн."))
            svcSaveFlights()
        }
        return
    }
    if (f.phase === "parked") {
        if (svcDay() < (f.pickupDay || 0)) return
        if (!player) return                                            // некого забирать - ждём, пока зайдёт в игру
        f.phase = "pickup_coming"
        f.at = now
        f.craft = null
        player.tell(Text.of("§9[Рейс] §fБорт вылетел за вами."))
        svcSaveFlights()
    }
}

function svcFlightsTick(now) {
    var list = svcFlights()
    if (!list.length) return
    list.slice().forEach(f => {
        try { svcFlightTick(f, now) } catch (e) { svcErr("рейс " + f.id, e) }
    })
}

/** Пилотирование бортов услуг - каждые два тика, как у гостей. */
function svcFlyTick() {
    for (var id in SVC_FLY_RT) {
        var c = SVC_FLY_RT[id]
        if (!c || !c.vehicle || !c.vehicle.isAlive()) { delete SVC_FLY_RT[id]; continue }
        if (c.mode !== "ai" || c.landed) continue
        try { gsFly(c) } catch (e) { svcErr("пилот", e) }
    }
}

// ─── Тик и команды ───────────────────────────────────────────────────────────

ServerEvents.tick(event => {
    if (!SVC_SERVER) SVC_SERVER = event.server
    var tick = event.server.tickCount
    if (tick % 2 === 0) svcFlyTick()
    if (tick % 40 !== 0) return
    var now = Number(event.server.overworld().getTime())
    try { svcPlansTick() } catch (e) { svcErr("планы", e) }
    try { svcFlightsTick(now) } catch (e) { svcErr("рейсы", e) }
})

ServerEvents.commandRegistry(event => {
    var Commands = event.commands
    var Arguments = event.arguments
    try {
        event.register(Commands.literal("tfgflight")
            .then(Commands.argument("x", Arguments.INTEGER.create(event))
                .then(Commands.argument("z", Arguments.INTEGER.create(event))
                    .then(Commands.argument("days", Arguments.INTEGER.create(event)).executes(ctx => {
                        var player = ctx.source.getPlayerOrException()
                        try {
                            svcOrderFlight(player, Number(Arguments.INTEGER.getResult(ctx, "x")),
                                Number(Arguments.INTEGER.getResult(ctx, "z")), Number(Arguments.INTEGER.getResult(ctx, "days")))
                        } catch (e) { ctx.source.sendFailure(Text.of("Рейс не заказан: " + e)) }
                        return 1
                    })))))
        event.register(Commands.literal("tfgsvc")
            .requires(s => s.hasPermission(2))
            .executes(ctx => {
                if (!SVC_SERVER) SVC_SERVER = ctx.source.getServer()
                var rows = []
                svcPlans().forEach(p => rows.push("§fзаказ: " + p.kind + " (" + p.faction + ") на день " + p.day + ", сегодня " + svcDay()))
                svcFlights().forEach(f => rows.push("§9рейс " + f.id + ": " + f.phase + " -> " + f.dest.x + " " + f.dest.z +
                    (f.pickupDay ? ", забрать в день " + f.pickupDay : "")))
                try {
                    var visits = gsLoad()
                    for (var id in visits) if (visits[id].merc) rows.push("§aнаёмники " + id + " (" + visits[id].faction + ") для " + visits[id].employerName)
                } catch (e) { }
                ctx.source.sendSuccess(Text.of(rows.length ? rows.join("\n") : "§7услуг нет"), false)
                return 1
            })
            .then(Commands.literal("clear").executes(ctx => {
                if (!SVC_SERVER) SVC_SERVER = ctx.source.getServer()
                svcFlights().slice().forEach(f => svcFlightDone(f, null))
                SVC_PLANS = []
                svcSavePlans()
                ctx.source.sendSuccess(Text.of("Заказы и рейсы очищены."), false)
                return 1
            })))

    } catch (err) {
        console.error("[services] ошибка регистрации команд: " + err)
    }
})

global.TFG_SERVICES = {
    guardPrice: player => svcGuardPrice(player),
    requestTrader: (ctx, kindId) => svcRequestTrader(ctx, kindId),
    hireGuards: ctx => svcHireGuards(ctx),
    flightPrice: (dist, days) => svcFlightPrice(dist, days),
    mercOf: player => svcMercOf(player),
    mercVisitOf: e => svcMercVisitOf(e),
    squadLeader: v => svcSquadLeader(v),
    paySquad: (player, v) => svcPaySquad(player, v),
}
