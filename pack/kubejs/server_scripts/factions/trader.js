// priority: 0
"use strict";

/**
 * ТОРГОВЦЫ ФРАКЦИЙ (прототип этапа 2).
 *
 * Приходят пешком из-за края (48-64 блока) к центру базы фракции игрока (factions/settlements.js),
 * если базы нет - к игроку. Сутки игрового времени бродят около центра, потом уходят и исчезают,
 * когда рядом нет игроков. Правый клик - окно сделки (factions/trade_menu.js).
 *
 * Виды (factions/trade_goods.js): оружейник, бронник, строитель, мясник, охотник, садовник, портной,
 * механик - продают товары по тиру игрока за монеты (factions/coins.js); оценщик - раз в месяц
 * календаря TFC верифицирует монеты на крупную сумму за комиссию, приходит только при отношениях
 * от TR_APPRAISER_REP, таймер у каждой фракции свой; скупщик - покупает драгоценности и платит
 * верифицированными монетами случайного номинала.
 *
 * Сущность временная: мирный хаск в одежде цвета фракции (цвет вместо скина).
 * Вызов: /tfgtrader [фракция] [вид] (оператор). Для визитов - global.TFG_TRADER_VISIT(level, center, factionId, kindId, tier).
 */

const TR_HEIGHTMAP = Java.loadClass("net.minecraft.world.level.levelgen.Heightmap$Types").MOTION_BLOCKING_NO_LEAVES
const TR_ZombieAttackGoal = Java.loadClass("net.minecraft.world.entity.ai.goal.ZombieAttackGoal")
const TR_Calendars = Java.loadClass("net.dries007.tfc.util.calendar.Calendars")
const TR_VISIT_TICKS = 24000        // сутки
const TR_ARRIVE_MIN = 48
const TR_ARRIVE_MAX = 64
const TR_STAY_RADIUS = 12
const TR_LEAVE_DIST = 90
const TR_MAX_OFFERS = 216       // до восьми страниц по 27 в окне сделки (factions/trade_menu.js)
const TR_APPRAISER_REP = 75         // отношения фракции с игроком, при которых приходит оценщик
const TR_APPRAISE_LIMIT = 5000      // сумма верификации за раз, медяков
const TR_APPRAISE_COMMISSION = 0.1
const TR_HELD = {
    weaponsmith: "minecraft:bow", armorer: "tfc:metal/shield/copper", builder: "tfc:mortar", butcher: "tfc:food/beef",
    hunter: "minecraft:bow", gardener: "tfc:seeds/wheat", tailor: "tfc:wool_cloth", mechanic: "create:wrench",
    blacksmith: "gtceu:copper_hammer", carpenter: "tfc:wood/lumber/oak", potter: "tfc:ceramic/jug", cook: "tfc:food/wheat_bread",
    fisherman: "tfc:metal/fishing_rod/copper", miner: "tfc:metal/propick/copper", electrician: "gtceu:basic_electronic_circuit",
    appraiser: "createdeco:gold_coin", buyer: "createdeco:gold_coin",
}

var TR_SERVER = null
var TR_ACTIVE = {}          // uuid -> { e, nextWander, leaveTo }
var TR_PENDING = null       // данные визита, пока выполняется наш summon
var TR_LAST_ENTITY = null   // последний появившийся торговец (для factions/guests.js)
var TR_GOAL_FIELDS = null

function trLog(msg) { global.tfgLog("tfg trader", msg) }
function trErr(msg, e) { global.tfgLogError("tfg trader", msg, e) }

function trFaction(id) {
    var list = global.TFG_FACTIONS.list
    for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i]
    return null
}

function trColor(faction) {
    var colors = global.TFG_FACTION_COLORS
    for (var i = 0; i < colors.length; i++) if (colors[i].id === faction.dye) return colors[i]
    return colors[0]
}

function trValidItem(id) {
    try { return !Item.of(id).isEmpty() } catch (e) { return false }
}

function trLore(lines) {
    return { display: { Lore: lines.map(l => JSON.stringify({ text: l, color: "gray", italic: false })) } }
}

// ─── Появление ───────────────────────────────────────────────────────────────

// ─── Товар торговца: специализация, случайный набор, объёмы ──────────────────
//
// Торговец везёт не весь ассортимент вида, а своё (TG_SPECS в trade_goods.js): специализация
// зависит от seed - личности именного торговца или его места в поселении, поэтому у одного
// человека она всегда одна. Набор при каждом пополнении свой: около TR_SPEC_SHARE товара своей
// специализации и немного чужого вразнобой. Расходный товар (слитки, руда, еда, патроны)
// везут горой - от TR_BULK_MIN штук, штучный (оружие, доспехи, стволы) - как раньше.

const TR_SPEC_SHARE = 0.6
const TR_SPEC_MIN = 10               // меньше этого своего товара не бывает (если он есть)
const TR_SPEC_MAX = 48
const TR_OTHER_SHARE = 0.08          // доля чужого товара «вразнобой»
const TR_OTHER_MAX = 8
const TR_BULK_MIN = 64

function trHash(s) {
    var h = 7
    s = String(s)
    for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 1000000007
    return h
}

function trShuffle(list) {
    for (var i = list.length - 1; i > 0; i--) {
        var j = Math.floor(Math.random() * (i + 1))
        var t = list[i]; list[i] = list[j]; list[j] = t
    }
    return list
}

/** Специализация торговца вида kindId по его seed; null - у вида специализаций нет. */
function trSpec(kindId, seed) {
    var specs = []
    try { specs = global.TFG_TRADE_GOODS.specs(kindId) || [] } catch (e) { }
    if (!specs.length) return null
    return specs[seed ? trHash(seed) % specs.length : Math.floor(Math.random() * specs.length)]
}

/** Товар торговца: своя специализация, случайная часть ассортимента, расходное - горой. */
function trOffers(kindId, tier, seed) {
    var goods = global.TFG_TRADE_GOODS.offers(kindId, tier)
        .filter(g => g.gun || g.ammo ? !!global.TFG_GUN_ITEMS.offerStack(g, 1) : trValidItem(g.item))
    goods.forEach((g, i) => { g.order = i })
    var spec = trSpec(kindId, seed)
    var own = spec ? goods.filter(g => { try { return spec.match(g) } catch (e) { return false } }) : goods
    var other = spec ? goods.filter(g => own.indexOf(g) < 0) : []
    var ownN = Math.min(own.length, TR_SPEC_MAX, Math.max(TR_SPEC_MIN, Math.round(own.length * TR_SPEC_SHARE)))
    var otherN = Math.min(other.length, TR_OTHER_MAX, Math.round(other.length * TR_OTHER_SHARE))
    var picked = trShuffle(own.slice()).slice(0, ownN).concat(trShuffle(other.slice()).slice(0, otherN))
    picked.sort((a, b) => a.order - b.order)      // в окне товар идёт группами, как в ассортименте
    picked.forEach(g => {
        delete g.order
        if (!global.TFG_TRADE_GOODS.bulk(g)) return
        var lot = Math.max(1, g.count)
        var want = TR_BULK_MIN * (1 + Math.random() * 3)          // от 64 до ~250 штук
        g.stock = Math.max(g.stock, Math.ceil(want / lot))
    })
    if (spec) picked.spec = spec.name
    return picked.length > TR_MAX_OFFERS ? picked.slice(0, TR_MAX_OFFERS) : picked
}

function trLeather(id, hex) {
    return '{id:"minecraft:' + id + '",Count:1b,tag:{display:{color:' + hex + '}}}'
}

/** Предмет одежды TFC Textile для NBT, если он есть в сборке; иначе - крашеная кожа. */
function trCloth(id, fallback, hex) {
    return trValidItem("tfc_textile:" + id) ? '{id:"tfc_textile:' + id + '",Count:1b}' : trLeather(fallback, hex)
}

/** Торговец ходит в одежде, а не в броне; сапоги - крашеные в цвет фракции (по ним видно, чей). */
function trOutfit(kindId, hex) {
    if (kindId === "hunter") {
        var fur = ["caribou", "direwolf", "black_bear", "cougar"][Math.floor(Math.random() * 4)]
        return [trLeather("leather_boots", hex), trCloth(fur + "_pants", "leather_leggings", hex),
            trCloth(fur + "_shirt", "leather_chestplate", hex), trCloth(fur + "_hat", "leather_helmet", hex)]
    }
    var hat = kindId === "tailor" || kindId === "cook" ? "cotton_hat" : "linen_hat"
    return [trLeather("leather_boots", hex), trCloth("linen_pants", "leather_leggings", hex),
        trCloth(kindId === "butcher" || kindId === "fisherman" ? "cotton_shirt" : "linen_shirt", "leather_chestplate", hex),
        trCloth(hat, "leather_helmet", hex)]
}

/**
 * Торговец появляется в 48-64 блоках от центра и идёт к нему. Возвращает текст ошибки или null.
 * opts (factions/guests.js): x, y, z - точка появления, guest - id визита с охраной и транспортом.
 */
function trVisit(level, center, factionId, kindId, tier, opts) {
    var faction = trFaction(factionId)
    if (!faction) return "нет фракции " + factionId
    var kind = global.TFG_TRADE_GOODS.kind(kindId)
    if (!kind) return "нет вида торговца " + kindId
    var color = trColor(faction)
    var ang = Math.random() * 6.283185307179586
    var dist = TR_ARRIVE_MIN + Math.random() * (TR_ARRIVE_MAX - TR_ARRIVE_MIN)
    var x = Math.floor(center.x + Math.cos(ang) * dist)
    var z = Math.floor(center.z + Math.sin(ang) * dist)
    var y = Number(level.getHeight(TR_HEIGHTMAP, x, z))
    try {
        var gsp = global.TFG_GROUND_SPOT(level, x, z, 12)        // не на крыше
        if (gsp) { x = Math.floor(gsp.x); z = Math.floor(gsp.z); y = gsp.y }
    } catch (e) { }
    if (opts && opts.x !== undefined) {
        x = opts.x
        y = opts.y
        z = opts.z
    }
    var person = null
    // тот же человек, что и раньше (оптовая поставка): его личность и имя
    try { if (opts && opts.person) person = global.TFG_NPC.person(opts.person) } catch (e) { }
    try { if (!person) person = global.TFG_NPC.personaFor(faction.id, kind.id) } catch (e) { }
    var title = (person ? person.name + " · " : "") + kind.name + " · " + faction.name
    var name = JSON.stringify(JSON.stringify({ text: title, color: color.text }))
    var held = trValidItem(TR_HELD[kind.id]) ? TR_HELD[kind.id] : "minecraft:paper"
    var nbt = "{Tags:[\"tfg_npc\",\"tfg_trader\",\"tfg_faction:" + faction.id + "\"],PersistenceRequired:1b,Silent:1b,CanPickUpLoot:0b," +
        "CustomNameVisible:1b,CustomName:" + name + "," +
        "ArmorItems:[" + trOutfit(kind.id, color.hex).join(",") + "]," +
        "ArmorDropChances:[0f,0f,0f,0f],HandItems:[{id:\"" + held + "\",Count:1b},{}],HandDropChances:[0f,0f]}"
    TR_PENDING = {
        faction: faction.id, kind: kind.id, tier: tier, dim: String(level.getDimension()),
        cx: Math.floor(center.x), cy: Math.floor(center.y), cz: Math.floor(center.z),
        until: Number(level.getTime()) + TR_VISIT_TICKS, entity: null, guest: opts && opts.guest ? opts.guest : null,
        person: person ? person.id : null,
    }
    try {
        TR_SERVER.runCommandSilent("execute in " + TR_PENDING.dim + " run summon minecraft:husk " + x + " " + y + " " + z + " " + nbt)
        if (!TR_PENDING.entity) return "торговец не появился (summon не сработал)"
        TR_LAST_ENTITY = TR_PENDING.entity
        trLog(faction.name + ": " + kind.name + " (тир " + tier + ") идёт к " + TR_PENDING.cx + " " + TR_PENDING.cz + " от " + x + " " + y + " " + z)
        return null
    } finally {
        TR_PENDING = null
    }
}

global.TFG_TRADER_VISIT = (level, center, factionId, kindId, tier) => trVisit(level, center, factionId, kindId, tier || 1)

/** Мирный хаск: без рукопашной цели зомби и без всех целей нападения. */
function trPacify(e) {
    if (!TR_GOAL_FIELDS) {
        var c = e.getClass()
        while (c && String(c.getName()) !== "net.minecraft.world.entity.Mob") c = c.getSuperclass()
        var gf = c.getDeclaredField("f_21345_")     // goalSelector
        var tf = c.getDeclaredField("f_21346_")     // targetSelector
        gf.setAccessible(true)
        tf.setAccessible(true)
        TR_GOAL_FIELDS = [gf, tf]
    }
    TR_GOAL_FIELDS[0].get(e).removeAllGoals(g => g instanceof TR_ZombieAttackGoal)
    TR_GOAL_FIELDS[1].get(e).removeAllGoals(g => true)
    e.setTarget(null)
}

EntityEvents.spawned(event => {
    var e = event.entity
    try {
        if (String(e.type) !== "minecraft:husk" || !e.getTags().contains("tfg_trader")) return
        var pd = e.persistentData
        if (TR_PENDING && !TR_PENDING.entity) {
            TR_PENDING.entity = e
            pd.putString("tfg_trader_faction", TR_PENDING.faction)
            pd.putString("tfg_trader_kind", TR_PENDING.kind)
            pd.putInt("tfg_trader_tier", TR_PENDING.tier)
            pd.putString("tfg_trader_dim", TR_PENDING.dim)
            pd.putInt("tfg_trader_cx", TR_PENDING.cx)
            pd.putInt("tfg_trader_cy", TR_PENDING.cy)
            pd.putInt("tfg_trader_cz", TR_PENDING.cz)
            pd.putLong("tfg_trader_until", TR_PENDING.until)
            var seed = TR_PENDING.person || String(e.uuid)
            var offers = trOffers(TR_PENDING.kind, TR_PENDING.tier, seed)
            pd.putString("tfg_trader_seed", seed)
            if (offers.spec) pd.putString("tfg_trader_spec", offers.spec)
            pd.putString("tfg_trader_offers", JSON.stringify(offers))
            if (TR_PENDING.guest) pd.putString("tfg_guest_visit", TR_PENDING.guest)
            if (TR_PENDING.person) pd.putString("tfg_npc_id", TR_PENDING.person)
        }
        if (!pd.contains("tfg_trader_until")) return
        trPacify(e)
        TR_ACTIVE[String(e.uuid)] = { e: e, nextWander: 0, leaveTo: null }
    } catch (err) {
        trErr("появление торговца", err)
    }
})

// ─── Поведение ───────────────────────────────────────────────────────────────

function trMoveNear(e, x, y, z, spread, speed) {
    var a = Math.random() * 6.283185307179586
    var r = Math.random() * spread
    e.getNavigation().moveTo(x + Math.cos(a) * r, y, z + Math.sin(a) * r, speed)
}

ServerEvents.tick(event => {
    if (!TR_SERVER) TR_SERVER = event.server
    if (event.server.tickCount % 20 !== 0) return
    for (var id in TR_ACTIVE) {
        var st = TR_ACTIVE[id]
        var e = st.e
        try {
            if (!e.isAlive() || e.isRemoved()) {
                delete TR_ACTIVE[id]
                continue
            }
            var pd = e.persistentData
            // в пути, на посадке и при отъезде торговцем управляет визит (factions/guests.js)
            if (pd.contains("tfg_guest_visit") && global.TFG_GUESTS && global.TFG_GUESTS.controls(e)) continue
            if (e.isPassenger()) continue
            var now = Number(e.level.getTime())
            var cx = pd.getInt("tfg_trader_cx") + 0.5
            var cy = pd.getInt("tfg_trader_cy")
            var cz = pd.getInt("tfg_trader_cz") + 0.5
            var dx = e.getX() - cx
            var dz = e.getZ() - cz
            var fromCenter = Math.sqrt(dx * dx + dz * dz)
            var nav = e.getNavigation()
            var near = e.level.getNearestPlayer(e, 5)

            if (now >= Number(pd.getLong("tfg_trader_until"))) {
                // сутки прошли - уходит и исчезает, когда никого нет рядом
                if (!st.leaveTo) {
                    var a = Math.atan2(dz, dx)
                    st.leaveTo = { x: cx + Math.cos(a) * TR_LEAVE_DIST, z: cz + Math.sin(a) * TR_LEAVE_DIST }
                    trLog("торговец уходит от " + Math.floor(cx) + " " + Math.floor(cz))
                }
                if (fromCenter > TR_LEAVE_DIST - 25 && !e.level.getNearestPlayer(e, 24)) {
                    e.discard()
                    delete TR_ACTIVE[id]
                    continue
                }
                if (nav.isDone()) nav.moveTo(st.leaveTo.x, e.getY(), st.leaveTo.z, 0.9)
                continue
            }
            if (near) {
                // игрок рядом - остановиться и смотреть на него
                nav.stop()
                // по координатам: setLookAt(игрок, 30, 30) для Rhino неоднозначен между перегрузками LookControl
                e.getLookControl().setLookAt(near.getX(), near.getEyeY(), near.getZ())
                continue
            }
            if (fromCenter > TR_STAY_RADIUS + 4) {
                if (nav.isDone()) trMoveNear(e, cx, cy, cz, 6, 1.0)
                continue
            }
            if (now >= st.nextWander) {
                trMoveNear(e, cx, cy, cz, TR_STAY_RADIUS, 0.6)
                st.nextWander = now + 160 + Math.floor(Math.random() * 160)
            }
        } catch (err) {
            trErr("поведение торговца", err)
            delete TR_ACTIVE[id]
        }
    }
})

// ─── Правила для окна сделки (factions/trade_menu.js) ────────────────────────

function trTitle(e) {
    var pd = e.persistentData
    var kind = global.TFG_TRADE_GOODS.kind(String(pd.getString("tfg_trader_kind")))
    var faction = trFaction(String(pd.getString("tfg_trader_faction")))
    var person = null
    try { person = global.TFG_NPC.personOf(e) } catch (err) { }
    // глава своего каравана (factions/fairs.js) - не персонаж базы, имя хранится прямо в торговце
    var own = person ? person.name : (pd.contains("tfg_npc_name") ? String(pd.getString("tfg_npc_name")) : null)
    return (own ? own + " · " : "") + (kind ? kind.name : "Торговец") + " · " + (faction ? faction.name : "?")
}

function trToday() { return Number(TR_Calendars.SERVER.getTotalCalendarDays()) }
function trMonth() { return Math.max(1, Number(TR_Calendars.SERVER.getCalendarDaysInMonth())) }

function trAppraiseKey(player, factionId) {
    return "tfg_appraise_" + global.TFG_FACTIONS.teamOf(player).key + "_" + factionId
}

/** Сколько дней до следующей верификации у этой фракции; 0 - доступно. */
function trAppraiseWait(player, factionId) {
    var pd = player.getServer().persistentData
    var k = trAppraiseKey(player, factionId)
    if (!pd.contains(k)) return 0
    return Math.max(0, Number(pd.getLong(k)) + trMonth() - trToday())
}

global.TFG_TRADER_RULES = {
    title: e => trTitle(e),
    appraiserRep: TR_APPRAISER_REP,
    appraiseLimit: TR_APPRAISE_LIMIT,
    commission: TR_APPRAISE_COMMISSION,
    appraiseWait: (player, factionId) => trAppraiseWait(player, factionId),
    markAppraised: (player, factionId) => player.getServer().persistentData.putLong(trAppraiseKey(player, factionId), trToday()),
}

ItemEvents.entityInteracted(event => {
    var target = event.target
    if (!target || String(target.type) !== "minecraft:husk" || !target.getTags().contains("tfg_trader")) return
    if (String(event.hand) === "MAIN_HAND") {
        try {
            if (!TR_SERVER) TR_SERVER = event.server
            // сначала разговор: торговля - первый вариант ответа (factions/dialogue.js)
            if (event.player.isCrouching()) global.TFG_TRADE_MENU.open(event.player, target)
            else global.TFG_DIALOGUE.open(event.player, target)
        } catch (err) {
            trErr("разговор", err)
            try { event.player.tell(Text.of("§cРазговор не открылся: " + String(err).substring(0, 250))) } catch (e2) { }
        }
    }
    // вне try: cancel() в KubeJS прерывает обработчик исключением-выходом
    event.cancel()
})

// ─── Команда: /tfgtrader [фракция] [вид] ─────────────────────────────────────

ServerEvents.commandRegistry(event => {
  try {
    var Commands = event.commands
    var run = (ctx, factionId, kindId, tierOverride, mode) => {
        try {
            if (!TR_SERVER) TR_SERVER = ctx.source.getServer()
            var player = ctx.source.getPlayerOrException()
            var base = global.TFG_SETTLEMENTS ? global.TFG_SETTLEMENTS.baseFor(player) : null
            var center = base ? { x: base.x, y: base.y, z: base.z } : { x: player.getX(), y: player.getY(), z: player.getZ() }
            if (!factionId) {
                var peaceful = global.TFG_FACTIONS.list.filter(f => f.id !== "bandits")
                factionId = peaceful[Math.floor(Math.random() * peaceful.length)].id
            }
            var tier = tierOverride || (global.TFG_PLAYER_TIER ? global.TFG_PLAYER_TIER(player) : 1)
            if (kindId === "any") kindId = null
            if (!kindId) {
                var common = global.TFG_TRADE_GOODS.kindsFor(tier)
                kindId = common[Math.floor(Math.random() * common.length)].id
            }
            var kind = global.TFG_TRADE_GOODS.kind(kindId)
            if (kind.minTier > tier) {
                ctx.source.sendFailure(Text.of(kind.name + " приходит с тира " + kind.minTier + " (у вас " + tier + ")."))
                return 1
            }
            if (kindId === "appraiser") {
                var rep = global.TFG_FACTIONS.rep(player, factionId)
                if (rep < TR_APPRAISER_REP) {
                    ctx.source.sendFailure(Text.of("Оценщик этой фракции приходит только при отношениях от " + TR_APPRAISER_REP +
                        " (сейчас " + Math.round(rep) + "). Поднять для проверки: /tfgfaction rep add " + factionId + " 80"))
                    return 1
                }
            }
            // охотник, лесоруб, шахтёр, камнелом: _worker - ремесленник-одиночка, _trader - торговец его товаром с охраной
            var caravan = mode === "trader"
            var err = global.TFG_GUESTS ? global.TFG_GUESTS.visit(player.level, center, factionId, kindId, tier, caravan ? { caravan: true } : null)
                : trVisit(player.level, center, factionId, kindId, tier)
            var who = global.TFG_TRADE_GOODS.kind(kindId).name + (mode === "trader" ? " (торговец с охраной)" : mode === "worker" ? " (ремесленник-одиночка)" : "")
            ctx.source.sendSuccess(Text.of(err ? "§cТорговец не пришёл: " + err
                : who + " (тир " + tier + ") идёт к " +
                    (base ? "центру базы " + base.faction.name : "вам (центр базы не отмечен или вы вне поселения)") + "."), false)
        } catch (e) {
            ctx.source.sendFailure(Text.of("Ошибка /tfgtrader: " + String(e).substring(0, 300)))
        }
        return 1
    }
    // Списки берём осторожно: порядок загрузки скриптов на сервере иной, чем в одиночной игре,
    // и trade_goods.js может ещё не отработать. Исключение здесь валит РЕГИСТРАЦИЮ ЦЕЛИКОМ -
    // вместе с командами всех файлов, что грузятся следом (так пропадал /tfgstreet).
    var factions = []
    try { factions = global.TFG_FACTIONS.list.slice() } catch (e) { console.error("[торговец] нет списка фракций: " + e) }
    var kinds = []
    try { kinds = global.TFG_TRADE_GOODS.kinds.map(k => k.id) } catch (e) { console.error("[торговец] нет видов товара: " + e) }

    var cmd = Commands.literal("tfgtrader").requires(src => src.hasPermission(2)).executes(ctx => run(ctx, null, null))
    factions.forEach(f => {
        var node = Commands.literal(f.id).executes(ctx => run(ctx, f.id, null))
        // /tfgtrader <фракция> <вид|any> [тир 1-10] - тир вместо тира игрока, для проверки
        kinds.concat(["any"]).forEach(kid => {
            var kn = Commands.literal(kid).executes(ctx => run(ctx, f.id, kid))
            ;[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].forEach(tier => {
                kn.then(Commands.literal(String(tier)).executes(ctx => run(ctx, f.id, kid, tier)))
            })
            node.then(kn)
        })
        // ремёсла-одиночки: <вид>_worker - ремесленник пешком без охраны, <вид>_trader - торговец этим товаром с охраной
        ;["hunter", "lumberjack", "miner", "quarryman"].filter(k => kinds.indexOf(k) >= 0).forEach(kid => {
            ;["worker", "trader"].forEach(mode => {
                var mn = Commands.literal(kid + "_" + mode).executes(ctx => run(ctx, f.id, kid, null, mode))
                ;[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].forEach(tier => {
                    mn.then(Commands.literal(String(tier)).executes(ctx => run(ctx, f.id, kid, tier, mode)))
                })
                node.then(mn)
            })
        })
        cmd.then(node)
    })
    event.register(cmd)
  } catch (err) {
    console.error("[торговец] ошибка регистрации команд: " + err)
  }
})
