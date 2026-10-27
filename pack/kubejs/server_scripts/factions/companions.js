// priority: -14
"use strict";
/**
 * СПУТНИКИ И ЖИТЕЛИ БАЗЫ (этап 7 плана NPC: Downloads/TFG-NPC-план.md).
 *
 * СПУТНИК. «Пойдёшь со мной?» - друг идёт даром, приятель - за 100 медяков, прочие откажут; правитель
 * поселения не бросит. Не больше двух спутников. Спутник:
 *   - ходит следом; отстал дальше 32 блоков, застрял, попал в воду или лаву - переносится к игроку;
 *   - садится к игроку в лодку или повозку, если есть место; нет - едет «следом» переносами;
 *   - бьёт того, кто ударил игрока, и того, кого бьёт игрок;
 *   - не гибнет от падения, утопления и удушья в стене; случайный удар хозяина его не ранит;
 *   - иногда заговаривает в пути;
 *   - «Подожди здесь» / «Идём дальше», «Возвращайся домой».
 * Игрок вышел и вошёл, а спутник остался далеко (или пропал) - он появляется рядом.
 *
 * ЖИТЕЛЬ БАЗЫ. «Живи у меня на базе» (нужна база фракции игрока, settlements.js) - житель уходит на базу
 * и живёт там: бродит около неё, воины бьют монстров в 20 блоках, все едят дважды в день самое сытное
 * из хранилищ базы; три дня голода - уходит домой с обидой. «Возвращайся домой» - обратно в поселение.
 *
 * Запись жителя: s.away = "спутник" | "база", s.comp = { owner, mode: "идёт"|"ждёт"|"база", base, hungry, ... }.
 * Сущность - метка tfg_companion; деревенские дела (settlers.js) её не трогают (seEntities её пропускает).
 */

const CP_MAX = 2
const CP_HIRE_PRICE = 100
const CP_FAR = 32
const CP_NEAR = 4
const CP_BASE_R = 20
const CP_DAY = 24000
const CP_UUID = Java.loadClass("java.util.UUID")

var CP_STUCK = {}                     // uuid сущности -> { x, z, at }
var CP_BARK_AT = {}                   // uuid сущности -> тик сервера
var CP_LOST = {}                      // "vid|sid" -> тик, с которого спутника нет в мире

function cpLog(m) { try { global.tfgLog("tfg companions", m) } catch (e) { } }
function cpPick(a) { return a[Math.floor(Math.random() * a.length)] }

// ─── Записи ──────────────────────────────────────────────────────────────────

function cpMine(player) {
    var out = [], u = String(player.uuid), vs = global.TFG_SETTLERS.list()
    for (var vid in vs) vs[vid].settlers.forEach(s => { if (s.comp && s.comp.owner === u && !s.dead) out.push({ v: vs[vid], s: s }) })
    return out
}

function cpEntity(level, v, s) {
    try {
        var list = level.getEntities()
        for (var i = 0; i < list.size(); i++) {
            var e = list.get(i)
            if (!e || !e.getTags || !e.isAlive()) continue
            var t = e.getTags()
            if (t.contains("tfg_v_" + v.id) && t.contains("tfg_sid_" + s.id)) return e
        }
    } catch (e) { }
    return null
}

/** Все спутники и жители базы в мире: { e, v, s }. */
function cpAll(level) {
    var out = [], vs = global.TFG_SETTLERS.list()
    try {
        var list = level.getEntities()
        for (var i = 0; i < list.size(); i++) {
            var e = list.get(i)
            if (!e || !e.getTags || !e.isAlive() || !e.getTags().contains("tfg_companion")) continue
            var vid = seTagValue(e, "tfg_v_"), sid = seTagValue(e, "tfg_sid_")
            var v = vs[vid], s = v ? v.settlers.filter(x => x.id === sid)[0] : null
            if (v && s && s.comp) out.push({ e: e, v: v, s: s })
        }
    } catch (e) { }
    return out
}

function cpOwner(server, s) {
    try { return server.getPlayerList().getPlayer(CP_UUID.fromString(s.comp.owner)) } catch (e) { return null }
}

function cpMark(e, on) {
    try { if (on) e.addTag("tfg_companion"); else e.removeTag("tfg_companion") } catch (err) { }
}

// ─── Позвать, отпустить, поселить на базе ────────────────────────────────────

const CP_YES = ["Пойду. С тобой хоть на край света.", "Давно хотел посмотреть мир. Идём.", "Веди. Я рядом."]
const CP_PAY = ["Пойду, но не задаром. Сотню медяков - и я твой спутник.", "Дорога опасна. Заплатишь сотню - пойду."]
const CP_NO = ["С тобой? Не знаю тебя толком. Нет.", "У меня тут дела. Не пойду.", "Сначала заслужи моё доверие."]
const CP_RULER = "Я не могу бросить поселение. Люди на меня смотрят."
const CP_FULL = "У тебя и так попутчиков хватает."
const CP_POOR = "Денег-то у тебя нет. Приходи, когда будут."
const CP_WAIT = ["Хорошо, жду здесь.", "Подожду. Не задерживайся."]
const CP_GO = ["Идём.", "Наконец-то. Пошли."]
const CP_HOME = ["Спасибо за дорогу. Пойду домой.", "Будет нужда - зови. Я дома."]
const CP_BASE_YES = ["Твоя база - мой дом. Только корми как следует.", "Пойду к тебе жить. Посмотрим, как у вас там."]
const CP_NO_BASE = "Куда идти-то? У тебя и базы нет."
const CP_HUNGRY_LEAVE = "Три дня без еды. Я ухожу домой, и не зови меня больше."
const CP_HUNGRY_LEAVE_OATH = "Я терпел, сколько мог, и клятву помню. Но пять дней без еды - это уже не дорога. Ухожу."

function cpIsSettler(ctx) { try { return ctx.trader.getTags().contains("tfg_settler") } catch (e) { return false } }
function cpOf(ctx) {
    var w = tkWho(ctx)
    return w && w.s.comp && w.s.comp.owner === String(ctx.player.uuid) ? w : null
}

function cpRecruit(ctx) {
    var w = tkWho(ctx)
    if (!w) return
    if (w.s.role === "правитель") return dlgSay(ctx, CP_RULER)
    if (cpMine(ctx.player).length >= CP_MAX) return dlgSay(ctx, CP_FULL)
    var tier = rlTier(w.op.value)
    if (tier >= 4) { dlgSay(ctx, cpPick(CP_YES)); return cpStart(ctx, w, "идёт") }
    if (tier === 3) {
        dlgSay(ctx, cpPick(CP_PAY))
        return dlgChoice(ctx, null, [
            { label: "Заплатить " + CP_HIRE_PRICE + " медяков", hint: "Проверенными монетами", run: c => {
                var ok = false
                try { ok = global.TFG_COINS.pay(c.player, CP_HIRE_PRICE) } catch (e) { }
                if (!ok) return dlgSay(c, CP_POOR)
                dlgSay(c, cpPick(CP_YES))
                cpStart(c, w, "идёт")
            } },
        ])
    }
    dlgSay(ctx, cpPick(CP_NO))
}

function cpStart(ctx, w, mode) {
    w.s.away = mode === "база" ? "база" : "спутник"
    w.s.comp = { owner: String(ctx.player.uuid), mode: mode, since: Math.floor(Number(ctx.player.level.getTime()) / CP_DAY), ate: 0, eatDay: -1, hungry: 0 }
    cpMark(ctx.trader, true)
    try { ctx.trader.getNavigation().stop() } catch (e) { }
    try { global.TFG_SETTLERS.save() } catch (e) { }
    cpLog(w.s.name + " (" + w.v.id + ") - спутник " + ctx.player.username)
    dlgNote(ctx, w.s.name + " теперь твой спутник. Команды - в разговоре с ним.")
}

function cpRelease(ctx, w, why) {
    var e = ctx.trader
    delete w.s.comp
    delete w.s.away
    cpMark(e, false)
    // домой - к кровати
    try { if (w.s.bed) e.teleportTo(w.s.bed.x + 0.5, w.s.bed.y, w.s.bed.z + 0.5) } catch (err) { }
    try { global.TFG_SETTLERS.save() } catch (err) { }
    cpLog(w.s.name + " отпущен домой (" + why + ")")
}

function cpSettleBase(ctx, w) {
    var base = null
    try { base = global.TFG_SETTLEMENTS.baseFor(ctx.player) } catch (e) { }
    if (!base || typeof base.x !== "number") return dlgSay(ctx, CP_NO_BASE)
    dlgSay(ctx, cpPick(CP_BASE_YES))
    w.s.away = "база"
    w.s.comp.mode = "база"
    w.s.comp.base = { x: Math.floor(base.x), y: Math.floor(base.y || 70), z: Math.floor(base.z) }
    try {
        var ty = stTop(ctx.player.level, base.x, base.z) + 1
        w.s.comp.base.y = ty
        ctx.trader.teleportTo(base.x + 0.5, ty, base.z + 0.5)
    } catch (e) { }
    try { global.TFG_SETTLERS.save() } catch (e) { }
    dlgNote(ctx, w.s.name + " будет жить у твоей базы (" + w.s.comp.base.x + " " + w.s.comp.base.z + "). Кормить - едой в хранилищах базы, дважды в день.")
}

// ─── Ход спутников ───────────────────────────────────────────────────────────

const CP_BARK = ["Далеко ещё?", "Хорошая погода для дороги.", "Слышишь? Кажется, кто-то идёт.", "Ноги гудят, но я не жалуюсь.",
    "А ты знаешь, куда мы идём? Я - нет.", "Будь начеку. Тут всякое водится.", "Хорошо идти не одному.", "Привал бы скоро.",
    "Я тебя в обиду не дам.", "Смотри под ноги, тут камни."]

function cpPlaceNear(level, p, e) {
    var a = Math.random() * 6.283185307179586
    var x = Math.floor(p.getX() + Math.cos(a) * 2), z = Math.floor(p.getZ() + Math.sin(a) * 2)
    var y = Number(p.getY())
    try { var t = stTop(level, x, z); if (Math.abs(t + 1 - y) < 6) y = t + 1 } catch (err) { }
    try { e.teleportTo(x + 0.5, y, z + 0.5); e.getNavigation().stop() } catch (err) { }
}

function cpFollowTick(server) {
    var level = server.overworld()
    var now = Number(server.tickCount)
    cpAll(level).forEach(c => {
        var e = c.e, s = c.s
        if (s.comp.mode === "база") return cpBaseStep(level, c, now)
        var p = cpOwner(server, s)
        if (!p || s.comp.mode === "ждёт") return
        var u = String(e.uuid)
        // другой мир - за игроком переносом
        if (String(p.level.getDimension()) !== String(e.level.getDimension())) {
            try { e.teleportTo(p.level, p.getX(), p.getY(), p.getZ(), 0, 0) } catch (err) { }
            return
        }
        var dx = p.getX() - e.getX(), dz = p.getZ() - e.getZ(), dy = p.getY() - e.getY()
        var d2 = dx * dx + dz * dz + dy * dy
        // транспорт: сесть к игроку, если есть место; слез игрок - слезть
        try {
            if (p.isPassenger()) {
                var veh = p.getVehicle()
                if (!e.isPassenger() && d2 < 64) e.startRiding(veh, false)
                if (!e.isPassenger() && d2 > 256) cpPlaceNear(level, p, e)
                return
            } else if (e.isPassenger()) e.stopRiding()
        } catch (err) { }
        if (e.isInWater() || e.isInLava() || d2 > CP_FAR * CP_FAR) return cpPlaceNear(level, p, e)
        // застрял: дальше шести блоков и за пять секунд не сдвинулся
        var st = CP_STUCK[u]
        if (d2 > 36) {
            if (!st || Math.abs(st.x - e.getX()) + Math.abs(st.z - e.getZ()) > 1) CP_STUCK[u] = { x: e.getX(), z: e.getZ(), at: now }
            else if (now - st.at > 100) { delete CP_STUCK[u]; return cpPlaceNear(level, p, e) }
        } else delete CP_STUCK[u]
        // драка - не мешаем; иначе - следом
        try { if (e.getTarget && e.getTarget()) return } catch (err) { }
        try {
            if (d2 > CP_NEAR * CP_NEAR) e.getNavigation().moveTo(p.getX(), p.getY(), p.getZ(), d2 > 144 ? 1.3 : 1.0)
            else e.getNavigation().stop()
        } catch (err) { }
        // разговор в пути
        if (d2 < 100 && (!CP_BARK_AT[u] || now - CP_BARK_AT[u] > 4000) && Math.random() < 0.05) {
            CP_BARK_AT[u] = now
            try { seVoice(e, cpPick(CP_BARK)); server.scheduleInTicks(100, () => { try { seRestoreSettlerName(e) } catch (err2) { } }) } catch (err) { }
        }
    })
}

// ─── Жители базы ─────────────────────────────────────────────────────────────

const CP_FOOD = /^(tfc|firmalife|tfc_gourmet):food\//

/** Самая сытная еда из хранилищ у базы: съесть одну. true - поел. */
function cpEat(level, base) {
    var best = null, bestSlot = -1, bestH = null, bestScore = -1
    for (var x = base.x - 16; x <= base.x + 16; x += 1) {
        for (var z = base.z - 16; z <= base.z + 16; z += 1) {
            for (var y = base.y - 4; y <= base.y + 6; y++) {
                var be = null
                try { be = level.getBlock(x, y, z).getEntity() } catch (e) { continue }
                if (!be) continue
                var h = null
                try { h = be.getCapability(LB_ItemHandler).resolve().get() } catch (e) { continue }
                for (var i = 0; i < h.getSlots(); i++) {
                    var st = h.getStackInSlot(i)
                    if (st.isEmpty() || !CP_FOOD.test(String(st.id))) continue
                    // сытнее - приготовленное и сложное
                    var id = String(st.id), score = 1
                    if (/cooked_|bread|stew|soup|pie|sandwich|pizza|cake/.test(id)) score = 3
                    if (/stew|soup|pie|pizza|sandwich/.test(id)) score = 5
                    if (score > bestScore) { bestScore = score; best = st; bestSlot = i; bestH = h }
                }
            }
        }
    }
    if (!bestH) return false
    bestH.extractItem(bestSlot, 1, false)
    return true
}

// ─── Работа на базе по сословию ──────────────────────────────────────────────
//
// По плану (TFG-NPC-план.md, этап 7): крестьянин относит урожай в контейнер с зерном,
// знать торгует с караванами, военный защищает (защита была написана раньше).
//
// ЖАТВА БЕЗ ПОЛОМКИ. У грядок TFC свой обработчик правого щелчка - тот самый сбор, после
// которого грядка остаётся стоять. Мы вызываем его же через подставного игрока Forge, а не
// ломаем блок. Поэтому зрелость угадывать не нужно: неспелая грядка сама отвечает «ничего
// не произошло», и тогда мы её не трогаем. Испортить урожай этот код не может.

var CP_BlockPos = null, CP_HitResult = null, CP_Vec3 = null, CP_Direction = null,
    CP_Hand = null, CP_FakePlayer = null, CP_javaFailed = false;

function cpJava() {
    if (CP_BlockPos) return true;
    if (CP_javaFailed) return false;
    try {
        CP_BlockPos = Java.loadClass("net.minecraft.core.BlockPos");
        CP_HitResult = Java.loadClass("net.minecraft.world.phys.BlockHitResult");
        CP_Vec3 = Java.loadClass("net.minecraft.world.phys.Vec3");
        CP_Direction = Java.loadClass("net.minecraft.core.Direction");
        CP_Hand = Java.loadClass("net.minecraft.world.InteractionHand");
        CP_FakePlayer = Java.loadClass("net.minecraftforge.common.util.FakePlayerFactory");
        return true;
    } catch (e) {
        CP_javaFailed = true;
        cpLog("работа на базе отключена: не загрузились классы - " + e);
        return false;
    }
}

/** Что считаем зерном: по нему выбирается нужный контейнер. */
var CP_GRAIN = /grain|seeds|food\/(wheat|barley|oat|rye|rice|maize)/;
/** Что крестьянин вообще относит в хранилище (еда, семена, волокно - не инструменты и не руда). */
var CP_HAUL = /food\/|grain|seeds|straw|jute|papyrus|sugarcane|wool|hide/;

var CP_PLOT_R = 14;            // в каком радиусе от базы ищем грядки
var CP_PLOT_TTL = 24000;       // как часто пересматриваем, где грядки (игровые сутки)
var CP_HAUL_R = 10;            // в каком радиусе подбираем лежащее
var CP_WORK_EVERY = 100;       // как часто работаем (тиков)

/**
 * Грядки рядом с базой. Список запоминается на игровые сутки: обходить тысячи блоков каждый
 * раз незачем, а новые грядки появляются не быстрее.
 */
function cpPlots(level, s, b, now) {
    if (s.comp.plots && now - (s.comp.plotsAt || 0) < CP_PLOT_TTL) return s.comp.plots;
    var out = [];
    for (var x = b.x - CP_PLOT_R; x <= b.x + CP_PLOT_R; x++) {
        for (var z = b.z - CP_PLOT_R; z <= b.z + CP_PLOT_R; z++) {
            for (var y = b.y - 3; y <= b.y + 4; y++) {
                var id = null;
                try { id = String(level.getBlock(x, y, z).id); } catch (e) { continue }
                if (id.indexOf("tfc:crop/") !== 0) continue;
                out.push([x, y, z]);
            }
        }
    }
    s.comp.plots = out;
    s.comp.plotsAt = now;
    if (out.length) cpLog(s.name + ": грядок рядом с базой - " + out.length);
    return out;
}

/** Собрать грядку её же правым щелчком. true - собралось, false - не спелая или нельзя. */
function cpReap(level, x, y, z) {
    if (!cpJava()) return false;
    try {
        var pos = new CP_BlockPos(x, y, z);
        var state = level.getBlockState(pos);
        var fake = CP_FakePlayer.getMinecraft(level);
        if (!fake) return false;
        var hit = new CP_HitResult(new CP_Vec3(x + 0.5, y + 0.5, z + 0.5), CP_Direction.UP, pos, false);
        var res = String(state.use(level, fake, CP_Hand.MAIN_HAND, hit));
        return res === "SUCCESS" || res === "CONSUME" || res === "CONSUME_PARTIAL";
    } catch (e) { return false }
}

var CP_STORE_TTL = 6000;       // как часто пересматриваем, где стоят хранилища

/**
 * Где у базы хранилища. Обход куба в тридцать три блока стоит дорого, поэтому запоминаем
 * КООРДИНАТЫ на CP_STORE_TTL тиков, а сами обработчики берём заново каждый раз: сундук могли
 * разобрать, и держать ссылку на его обработчик нельзя.
 */
function cpStorePlaces(level, s, b, now) {
    if (s.comp.stores && now - (s.comp.storesAt || 0) < CP_STORE_TTL) return s.comp.stores;
    var out = [];
    for (var x = b.x - 16; x <= b.x + 16; x++) {
        for (var z = b.z - 16; z <= b.z + 16; z++) {
            for (var y = b.y - 4; y <= b.y + 6; y++) {
                var be = null;
                try { be = level.getBlock(x, y, z).getEntity(); } catch (e) { continue }
                if (!be) continue;
                var ok = false;
                try { ok = !!be.getCapability(LB_ItemHandler).resolve().get(); } catch (e) { continue }
                if (ok) out.push([x, y, z]);
            }
        }
    }
    s.comp.stores = out;
    s.comp.storesAt = now;
    if (out.length) cpLog(s.name + ": хранилищ у базы - " + out.length);
    return out;
}

/** Хранилища с содержимым: [{ h, x, y, z, grain, free }], grain - сколько в нём зерна. */
function cpStores(level, s, b, now) {
    var out = [];
    cpStorePlaces(level, s, b, now).forEach(p => {
        var be = null;
        try { be = level.getBlock(p[0], p[1], p[2]).getEntity(); } catch (e) { return }
        if (!be) return;
        var h = null;
        try { h = be.getCapability(LB_ItemHandler).resolve().get(); } catch (e) { return }
        if (!h) return;
        var grain = 0, free = 0;
        try {
            for (var i = 0; i < h.getSlots(); i++) {
                var st = h.getStackInSlot(i);
                if (!st || st.isEmpty()) { free++; continue }
                if (CP_GRAIN.test(String(st.id))) grain += st.getCount();
            }
        } catch (e) { return }
        out.push({ h: h, x: p[0], y: p[1], z: p[2], grain: grain, free: free });
    });
    return out;
}

/** Куда относить: где больше всего зерна, а если зерна нет нигде - где больше места. */
function cpGrainStore(stores) {
    var best = null;
    stores.forEach(st => {
        if (!best) { best = st; return }
        if (st.grain > best.grain) { best = st; return }
        if (st.grain === best.grain && st.free > best.free) best = st;
    });
    if (best && best.grain === 0 && best.free === 0) return null;
    return best;
}

/** Положить стопку в хранилище. Возвращает, сколько осталось не влезшим. */
function cpPut(store, stack) {
    var rest = stack;
    try {
        for (var i = 0; i < store.h.getSlots() && !rest.isEmpty(); i++) {
            rest = store.h.insertItem(i, rest, false);
        }
    } catch (e) { return stack }
    return rest;
}

/** Подобрать лежащее рядом и отнести в хранилище. Возвращает, сколько стопок унесено. */
function cpHaul(level, e, store) {
    if (typeof RAID_AABBClass === "undefined") return 0;
    var list = null;
    try {
        list = level.getEntities(e, new RAID_AABBClass(e.getX() - CP_HAUL_R, e.getY() - 3, e.getZ() - CP_HAUL_R,
            e.getX() + CP_HAUL_R, e.getY() + 3, e.getZ() + CP_HAUL_R));
    } catch (err) { return 0 }
    var taken = 0;
    for (var i = 0; i < list.size() && taken < 4; i++) {
        var it = list.get(i);
        if (!it || String(it.type) !== "minecraft:item") continue;
        var stack = null;
        try { stack = it.getItem(); } catch (err) { continue }
        if (!stack || stack.isEmpty()) continue;
        if (!CP_HAUL.test(String(stack.id))) continue;
        var rest = cpPut(store, stack.copy());
        if (rest.isEmpty()) { try { it.discard(); } catch (err) { } taken++; }
        else if (rest.getCount() < stack.getCount()) { try { it.setItem(rest); } catch (err) { } taken++; }
    }
    return taken;
}

/** Крестьянин: собрать одну спелую грядку и отнести лежащее в контейнер с зерном. */
function cpWorkPeasant(level, c, now) {
    var e = c.e, s = c.s, b = s.comp.base;
    var stores = cpStores(level, s, b, now);
    if (!stores.length) return;
    var store = cpGrainStore(stores);
    if (!store) return;

    // жатва: по одной грядке за раз, начиная с той, где остановились
    var plots = cpPlots(level, s, b, now);
    if (plots.length) {
        var at = Number(s.comp.plotAt || 0) % plots.length;
        for (var n = 0; n < plots.length; n++) {
            var p = plots[(at + n) % plots.length];
            var d2 = Math.pow(p[0] - e.getX(), 2) + Math.pow(p[2] - e.getZ(), 2);
            if (d2 > 4) {
                // идём к ближней грядке, а жнём, когда дойдём
                try { e.getNavigation().moveTo(p[0] + 0.5, p[1], p[2] + 0.5, 0.8); } catch (err) { }
                if (d2 < CP_PLOT_R * CP_PLOT_R * 4) break;
                continue;
            }
            if (cpReap(level, p[0], p[1], p[2])) {
                s.comp.plotAt = (at + n + 1) % plots.length;
                break;
            }
        }
    }
    // разноска: подобрать выпавшее и всё прочее добро у базы
    var taken = cpHaul(level, e, store);
    if (taken > 0) {
        try { e.getNavigation().moveTo(store.x + 0.5, store.y, store.z + 0.5, 0.8); } catch (err) { }
    }
}

// ─── Знать: торг с караванами ────────────────────────────────────────────────
//
// Торговец каравана держит свой вид и ассортимент у себя в данных (tfg_trader_kind,
// tfg_trader_offers - список { item, count, price, stock }), поэтому ничего заново не
// придумываем: знать покупает из того же ассортимента и по тем же ценам, что и игрок.
//
// Деньги берутся из сундука, где монет больше всего (по плану этапа 7). Считает и раскладывает
// их coins.js: в дело идут только верифицированные, сдача возвращается в тот же сундук.

var CP_DEAL_EVERY = 1200;      // как часто знать заключает сделку (тиков)
var CP_TRADER_R = 28;          // в каком радиусе от базы ищем торговца

var CP_DEAL_SAY = ["Караван пришёл - надо брать, пока не ушли.", "Сторговался. Недорого, по нынешним временам.",
    "Взял для хозяйства. Деньги в сундуке были, я не из своих платил.",
    "Пока ты ходишь где-то, дела делаются здесь."];
var CP_DEAL_POOR = ["Монет в сундуке нет. На что я, по-твоему, должен торговать?",
    "Караван есть, денег нет. Так торговли не выйдет."];

/** Торговец каравана рядом с базой (не житель этой базы). */
function cpTraderNear(level, e, b) {
    if (typeof RAID_AABBClass === "undefined") return null;
    var list = null;
    try {
        list = level.getEntities(e, new RAID_AABBClass(b.x - CP_TRADER_R, b.y - 12, b.z - CP_TRADER_R,
            b.x + CP_TRADER_R, b.y + 12, b.z + CP_TRADER_R));
    } catch (err) { return null }
    for (var i = 0; i < list.size(); i++) {
        var t = list.get(i);
        try {
            if (!t || !t.isAlive() || !t.getTags().contains("tfg_trader")) continue;
            if (t.getTags().contains("tfg_companion")) continue;
            if (!String(t.persistentData.getString("tfg_trader_offers"))) continue;
            return t;
        } catch (err) { }
    }
    return null;
}

/** Верифицированные монеты в хранилище: [{ slot, face, count }], сверху крупные. */
function cpCoinsIn(store) {
    var out = [];
    try {
        for (var i = 0; i < store.h.getSlots(); i++) {
            var st = store.h.getStackInSlot(i);
            if (!st || st.isEmpty()) continue;
            var face = 0;
            try { face = Number(global.TFG_COINS.faceValue(st)); } catch (e) { face = 0 }
            if (face <= 0) continue;
            var ok = false;
            try { ok = !!global.TFG_COINS.isVerified(st); } catch (e) { ok = false }
            if (!ok) continue;
            out.push({ slot: i, face: face, count: st.getCount() });
        }
    } catch (e) { return [] }
    out.sort((a, b) => b.face - a.face);
    return out;
}

function cpCoinTotal(store) {
    var sum = 0;
    cpCoinsIn(store).forEach(c => { sum += c.face * c.count });
    return sum;
}

/** Хранилище, где монет больше всего (или null). */
function cpCoinStore(stores) {
    var best = null, bestSum = 0;
    stores.forEach(st => {
        var sum = cpCoinTotal(st);
        if (sum > bestSum) { bestSum = sum; best = st }
    });
    return best;
}

/** Монета этого номинала, верифицированная. */
function cpCoinStack(id, count) {
    try { return coinVerifiedStack(id, count) } catch (e) { }
    return Item.of(id, count, { tfg_verified: true });
}

/** Выложить из сундука не меньше price; возвращает, сколько выложено (0 - не хватило). */
function cpTakeCoins(store, price) {
    var coins = cpCoinsIn(store), paid = 0;
    for (var i = 0; i < coins.length && paid < price; i++) {
        var c = coins[i];
        for (var n = 0; n < c.count && paid < price; n++) {
            var got = null;
            try { got = store.h.extractItem(c.slot, 1, false) } catch (e) { got = null }
            if (!got || got.isEmpty()) break;
            paid += c.face;
        }
    }
    return paid;
}

/** Сдачу - обратно в тот же сундук. */
function cpChangeBack(store, amount) {
    if (amount <= 0) return;
    var parts = [];
    try { parts = global.TFG_COINS.split(Math.round(amount)) } catch (e) { return }
    parts.forEach(p => { cpPut(store, cpCoinStack(p.id, p.count)) });
}

/** Куда положить купленное: где больше свободных ячеек. */
function cpRoomStore(stores) {
    var best = null;
    stores.forEach(st => { if (!best || st.free > best.free) best = st });
    return best && best.free > 0 ? best : null;
}

/** Знать: сторговаться с караваном за монеты из самого богатого сундука. */
function cpWorkNoble(level, c, now) {
    var e = c.e, s = c.s, b = s.comp.base;
    if (now - Number(s.comp.dealAt || 0) < CP_DEAL_EVERY) return;

    var trader = cpTraderNear(level, e, b);
    if (!trader) return;

    var stores = cpStores(level, s, b, now);
    if (!stores.length) return;
    var purse = cpCoinStore(stores);
    if (!purse) {
        s.comp.dealAt = now;
        if (!s.comp.poorSaid) { s.comp.poorSaid = true; try { seVoice(e, cpPick(CP_DEAL_POOR)) } catch (err) { } }
        return;
    }
    s.comp.poorSaid = false;

    var offers = null;
    try { offers = JSON.parse(String(trader.persistentData.getString("tfg_trader_offers"))) } catch (err) { return }
    if (!offers || !offers.length) return;

    // знать берёт самое дорогое из того, что по карману
    var money = cpCoinTotal(purse), pick = -1;
    for (var i = 0; i < offers.length; i++) {
        var o = offers[i];
        if (!o || !o.item || Number(o.stock) <= 0 || Number(o.price) <= 0) continue;
        if (Number(o.price) > money) continue;
        if (pick < 0 || Number(o.price) > Number(offers[pick].price)) pick = i;
    }
    if (pick < 0) { s.comp.dealAt = now; return }

    // подойти к торговцу; торгуемся, только когда дошли
    var d2 = Math.pow(trader.getX() - e.getX(), 2) + Math.pow(trader.getZ() - e.getZ(), 2);
    if (d2 > 12) {
        try { e.getNavigation().moveTo(trader.getX(), trader.getY(), trader.getZ(), 0.9) } catch (err) { }
        return;
    }

    var offer = offers[pick], price = Math.round(Number(offer.price));
    var room = cpRoomStore(stores);
    if (!room) { s.comp.dealAt = now; return }

    var paid = cpTakeCoins(purse, price);
    if (paid < price) {                                   // не набралось - вернуть всё назад
        cpChangeBack(purse, paid);
        s.comp.dealAt = now;
        return;
    }

    var goods = null;
    try { goods = Item.of(String(offer.item), Math.max(1, Number(offer.count) || 1)) } catch (err) { goods = null }
    if (!goods) { cpChangeBack(purse, paid); s.comp.dealAt = now; return }

    var rest = cpPut(room, goods);
    if (!rest.isEmpty()) {                                // не влезло - сделки не было
        cpChangeBack(purse, paid);
        s.comp.dealAt = now;
        return;
    }
    cpChangeBack(purse, paid - price);

    offer.stock = Number(offer.stock) - 1;
    try { trader.persistentData.putString("tfg_trader_offers", JSON.stringify(offers)) } catch (err) { }

    s.comp.dealAt = now;
    try { seVoice(e, cpPick(CP_DEAL_SAY)) } catch (err) { }
    try { rlNote(c.v, { uuid: s.comp.owner, username: "?" }, s.id, 1, "сторговался с караваном") } catch (err) { }
    cpLog(s.name + " купил " + offer.item + " x" + (offer.count || 1) + " за " + price + " (сдача " + (paid - price) + ")");
    try { global.TFG_SETTLERS.save() } catch (err) { }
}

/** Работа по сословию. Военные стерегут базу - это сделано отдельно, выше. */
function cpWork(level, c, now) {
    var s = c.s;
    if (now % CP_WORK_EVERY >= 20) return;
    var estate = "простолюдины";
    try { estate = String(global.TFG_SETTLERS.estateOf(s)); } catch (e) { }
    if (estate === "знать") cpWorkNoble(level, c, now);
    else if (estate === "простолюдины") cpWorkPeasant(level, c, now);
}

function cpBaseStep(level, c, now) {
    var e = c.e, s = c.s, b = s.comp.base
    if (!b) return
    // работа по сословию
    try { cpWork(level, c, now) } catch (err) { cpTickFail("работа на базе", err, now) }
    var dx = b.x - e.getX(), dz = b.z - e.getZ()
    // далеко от базы - домой; иначе бродит рядом
    if (dx * dx + dz * dz > CP_BASE_R * CP_BASE_R * 4) { try { e.teleportTo(b.x + 0.5, b.y, b.z + 0.5) } catch (err) { } }
    else if (now % 400 < 20) {
        try {
            if (!(e.getTarget && e.getTarget())) e.getNavigation().moveTo(b.x + (Math.random() - 0.5) * CP_BASE_R, b.y, b.z + (Math.random() - 0.5) * CP_BASE_R, 0.8)
        } catch (err) { }
    }
    // воины стерегут базу
    if (SE_FIGHTERS.indexOf(s.role) >= 0 && now % 40 < 20) {
        try {
            var list = level.getEntities()
            for (var i = 0; i < list.size(); i++) {
                var m = list.get(i)
                if (!m || !m.isAlive() || String(m.getType().getCategory()) !== "MONSTER" || (m.getTags && m.getTags().contains("tfg_npc"))) continue
                if (Math.pow(m.getX() - b.x, 2) + Math.pow(m.getZ() - b.z, 2) > CP_BASE_R * CP_BASE_R) continue
                e.setTarget(m)
                break
            }
        } catch (err) { }
    }
    // еда: дважды в сутки (утром и вечером), не поел за сутки - голод; три дня голода - уходит
    var day = Math.floor(Number(level.getTime()) / CP_DAY), tod = Number(level.getDayTime()) % CP_DAY
    var meal = tod < 12000 ? 0 : 1
    if (s.comp.eatDay !== day) { if (s.comp.eatDay >= 0 && (s.comp.ate || 0) === 0) s.comp.hungry = (s.comp.hungry || 0) + 1; s.comp.eatDay = day; s.comp.ate = 0; s.comp.meals = {} }
    s.comp.meals = s.comp.meals || {}
    if (!s.comp.meals[meal] && tod % 12000 > 1000) {
        s.comp.meals[meal] = true
        if (cpEat(level, b)) { s.comp.ate = (s.comp.ate || 0) + 1; s.comp.hungry = 0 }
        try { global.TFG_SETTLERS.save() } catch (err) { }
    }
    if ((s.comp.hungry || 0) >= (s.comp.oath ? CP_OATH_HUNGER : CP_HUNGER_PLAIN)) {
        try { seVoice(e, s.comp.oath ? CP_HUNGRY_LEAVE_OATH : CP_HUNGRY_LEAVE) } catch (err) { }
        try { rlNote(c.v, { uuid: s.comp.owner, username: "?" }, s.id, -25, "голодал на базе") } catch (err) { }
        delete s.comp
        delete s.away
        cpMark(e, false)
        try { if (s.bed) e.teleportTo(s.bed.x + 0.5, s.bed.y, s.bed.z + 0.5) } catch (err) { }
        try { global.TFG_SETTLERS.save() } catch (err) { }
        cpLog(s.name + " ушёл с базы: голод")
    }
}

// ─── Потерявшиеся спутники ───────────────────────────────────────────────────

/** Спутника игрока нет в мире дольше минуты - появиться рядом с игроком (старый, если найдётся, - лишний). */
function cpLostTick(server) {
    var level = server.overworld()
    var now = Number(server.tickCount)
    server.players.forEach(p => {
        cpMine(p).forEach(c => {
            if (c.s.comp.mode !== "идёт") return
            var key = c.v.id + "|" + c.s.id
            if (cpEntity(level, c.v, c.s)) { delete CP_LOST[key]; return }
            if (!CP_LOST[key]) { CP_LOST[key] = now; return }
            if (now - CP_LOST[key] < 1200) return
            delete CP_LOST[key]
            c.s.enterAt = { x: Math.floor(p.getX()) + 2, z: Math.floor(p.getZ()) + 2 }
            try { seSpawnOne(c.v, c.s, level); cpLog(c.s.name + " догнал " + p.username + " (появился рядом)") } catch (e) { }
        })
    })
}

var CP_WARNED = {}

/** Сбой в тике не должен ронять сервер, но и глотать его молча нельзя: пишем раз в минуту на место сбоя. */
function cpTickFail(where, err, tick) {
    if (CP_WARNED[where] && tick - CP_WARNED[where] < 1200) return
    CP_WARNED[where] = tick
    try {
        if (global.tfgLogError) global.tfgLogError("tfg companions", where, err)
        else console.error("[tfg companions/ОШИБКА] " + where + ": " + err)
    } catch (e) { }
}

ServerEvents.tick(event => {
    var t = event.server.tickCount
    if (t % 10 === 3) { try { cpFollowTick(event.server) } catch (e) { cpTickFail("ход спутников", e, t) } }
    if (t % 200 === 77) { try { cpLostTick(event.server) } catch (e) { cpTickFail("потерявшиеся", e, t) } }
})

// метка спутника - и после перезапуска, и у появившегося заново
EntityEvents.spawned(event => {
    try {
        var e = event.entity
        if (!e.getTags || !e.getTags().contains("tfg_settler")) return
        var vid = seTagValue(e, "tfg_v_"), sid = seTagValue(e, "tfg_sid_")
        var v = global.TFG_SETTLERS.list()[vid]
        var s = v ? v.settlers.filter(x => x.id === sid)[0] : null
        if (s && s.comp) cpMark(e, true)
    } catch (err) { }
})

// ─── Защита и бой ────────────────────────────────────────────────────────────

EntityEvents.hurt(event => {
    try {
        var victim = event.entity
        var src = event.source
        // спутник: падение, утопление, удушье и удар хозяина - не ранят
        if (victim.getTags && victim.getTags().contains("tfg_companion")) {
            var type = String(src.getType ? src.getType() : src.type)
            if (/fall|drown|inWall|in_wall|cramming/.test(type)) { event.cancel(); return }
            var pl = src.player
            if (pl) {
                var c = cpAll(victim.level).filter(x => String(x.e.uuid) === String(victim.uuid))[0]
                if (c && c.s.comp.owner === String(pl.uuid)) { event.cancel(); return }
            }
            return
        }
        // хозяина ударили - спутники на обидчика
        var attacker = src.actual || src.immediate
        if (victim.isPlayer && victim.isPlayer() && attacker && attacker.isLiving && attacker.isLiving()) {
            if (attacker.getTags && attacker.getTags().contains("tfg_companion")) return
            cpMine(victim).forEach(c => {
                var e = cpEntity(victim.level, c.v, c.s)
                if (e && c.s.comp.mode !== "база") { try { e.setTarget(attacker) } catch (err) { } }
            })
            return
        }
        // хозяин бьёт - спутники помогают (жителей и спутников не трогают)
        var hitter = src.player
        if (hitter && victim.isLiving && victim.isLiving() && !(victim.getTags && (victim.getTags().contains("tfg_settler") || victim.getTags().contains("tfg_companion")))) {
            cpMine(hitter).forEach(c => {
                var e = cpEntity(victim.level, c.v, c.s)
                if (e && c.s.comp.mode !== "база") { try { e.setTarget(victim) } catch (err) { } }
            })
        }
    } catch (err) { }
})

// погиб спутник - снять запись
EntityEvents.death(event => {
    try {
        var e = event.entity
        if (!e.getTags || !e.getTags().contains("tfg_companion")) return
        cpLog("спутник погиб: " + String(e.getName().getString()))
    } catch (err) { }
})

// ─── В окно разговора ────────────────────────────────────────────────────────

;(() => {
    if (typeof DLG_NPC_OPTIONS === "undefined") return
    var opts = [
        { id: "cp_recruit", label: () => "Пойдёшь со мной?", hint: () => "Друг пойдёт даром, приятель - за " + CP_HIRE_PRICE + " медяков. Не больше двух спутников.",
            show: ctx => cpIsSettler(ctx) && !cpOf(ctx) && !(tkWho(ctx) || { s: {} }).s.comp, run: ctx => cpRecruit(ctx) },
        { id: "cp_wait", label: () => "Подожди здесь", hint: () => "Останется на месте, пока не позовёшь.",
            show: ctx => { var w = cpOf(ctx); return !!w && w.s.comp.mode === "идёт" },
            run: ctx => { var w = cpOf(ctx); w.s.comp.mode = "ждёт"; try { ctx.trader.getNavigation().stop() } catch (e) { } global.TFG_SETTLERS.save(); dlgSay(ctx, cpPick(CP_WAIT)) } },
        { id: "cp_go", label: () => "Идём дальше", hint: () => "Снова пойдёт следом.",
            show: ctx => { var w = cpOf(ctx); return !!w && w.s.comp.mode !== "идёт" },
            run: ctx => { var w = cpOf(ctx); w.s.comp.mode = "идёт"; w.s.away = "спутник"; delete w.s.comp.base; global.TFG_SETTLERS.save(); dlgSay(ctx, cpPick(CP_GO)) } },
        { id: "cp_base", label: () => "Живи у меня на базе", hint: () => "Будет жить у базы твоей фракции: стеречь, есть из хранилищ дважды в день.",
            show: ctx => { var w = cpOf(ctx); return !!w && w.s.comp.mode !== "база" }, run: ctx => cpSettleBase(ctx, cpOf(ctx)) },
        { id: "cp_home", label: () => "Возвращайся домой", hint: () => "Отпустить в родное поселение.",
            show: ctx => !!cpOf(ctx), run: ctx => { var w = cpOf(ctx); dlgSay(ctx, cpPick(CP_HOME)); cpRelease(ctx, w, "отпустил хозяин"); dlgClose(ctx.player) } },
    ]
    ;[DLG_NPC_OPTIONS, typeof DLG_OPTIONS !== "undefined" ? DLG_OPTIONS : null].forEach(list => {
        if (!list) return
        opts.forEach(opt => {
            if (list.some(x => x.id === opt.id)) return
            var at = list.findIndex(o => o.id === "leave")
            list.splice(at < 0 ? list.length : at, 0, opt)
        })
    })
})()

// /tfgcomp - мои спутники и жители базы
ServerEvents.commandRegistry(event => {
    event.register(event.commands.literal("tfgcomp").executes(ctx => {
        var p = ctx.source.getPlayerOrException()
        var mine = cpMine(p)
        if (!mine.length) { p.tell(Text.of("§7Спутников нет. Позови жителя в разговоре: «Пойдёшь со мной?»")); return 1 }
        mine.forEach(c => p.tell(Text.of("§6• §7" + c.s.name + " (" + (c.s.role || "житель") + "): " + c.s.comp.mode +
            (c.s.comp.base ? ", база " + c.s.comp.base.x + " " + c.s.comp.base.z + (c.s.comp.hungry ? ", голодает дней: " + c.s.comp.hungry : "") : ""))))
        return 1
    }))
})

global.TFG_COMPANIONS = { mine: player => cpMine(player) }

// ─── Цепочки разговоров со спутником ─────────────────────────────────────────
//
// Движок - factions/talk_chains.js. Здесь не отдельные реплики, а связанные ветки: ответы
// зависят от сословия, от отношения, от того, голодал ли он, и от того, дал ли он клятву.
// Клятва - по канону (нити держат душу): у поклявшегося терпение к голоду с трёх дней до пяти,
// и он об этом прямо говорит.

const CP_OATH_HUNGER = 5;              // сколько дней голода терпит поклявшийся
const CP_HUNGER_PLAIN = 3;             // и сколько - непоклявшийся

function cpOathed(ctx) {
    var w = cpOf(ctx);
    return !!w && !!w.s.comp && !!w.s.comp.oath;
}

function cpModeOf(ctx) {
    var w = cpOf(ctx);
    return w && w.s.comp ? String(w.s.comp.mode || "") : "";
}

function cpHungryOf(ctx) {
    var w = cpOf(ctx);
    return w && w.s.comp ? Number(w.s.comp.hungry || 0) : 0;
}

;(() => {
    if (!global.TFG_TALK_CHAINS || !global.TFG_TALK_CHAINS.add) { cpLog("цепочки разговоров недоступны"); return }
    var add = global.TFG_TALK_CHAINS.add;

    // ─── Как тебе дорога ───
    add({
        id: "cp_tk_road",
        label: () => "Как тебе дорога?",
        hint: () => "О пути, об усталости и о том, что он думает про тебя.",
        show: ctx => !!cpOf(ctx) && cpModeOf(ctx) !== "база",
        start: "a",
        steps: {
            a: {
                say: ctx => {
                    var op = 0;
                    try { op = Number(global.TFG_RELATIONS.opinion(ctx.player, cpOf(ctx).v, cpOf(ctx).s)) } catch (e) { }
                    if (cpHungryOf(ctx) > 0) return ["Дорога-то ничего. Только брюхо пустое, а это портит всякую дорогу."];
                    if (op >= 60) return ["С тобой хорошо идти. Я бы и дальше пошёл, куда скажешь."];
                    if (op >= 20) return ["Идём - и ладно. Ноги держат, и то хлеб."];
                    return ["Иду, потому что сговорились. Не больше."];
                },
                ask: "О чём спросишь?",
                opts: [
                    { label: "Не устал?", go: "tired" },
                    { label: "Зачем ты пошёл со мной?", go: "why" },
                    { label: "Чего ты боишься в пути?", go: "fear" },
                    { label: "Ладно, идём.", go: null },
                ],
            },
            tired: {
                say: ctx => cpHungryOf(ctx) > 0
                    ? ["Устал не от ходьбы, а от голода. Я ел в последний раз сам не помню когда.",
                       "Если хочешь, чтобы я шёл дальше - корми. Это не каприз."]
                    : ["Нет. Я не барин, я ходил и дальше, и хуже.",
                       "Главное - не стоять на мокром. От мокрого потом ломит."],
                opts: [],
            },
            why: {
                say: ctx => {
                    var est = "простолюдины";
                    try { est = String(global.TFG_SETTLERS.estateOf(cpOf(ctx).s)) } catch (e) { }
                    if (est === "знать") return ["Дома я сижу при своём, а тут вижу, как живут другие. Это дороже, чем кажется.",
                        "И не делай вид, что ты меня нанял. Я пошёл сам."];
                    if (est === "военные") return ["Мне платят за то, чтобы стоять. А я хотел посмотреть, за что стою.",
                        "С тобой это видно быстрее."];
                    return ["Сидеть на одном месте всю жизнь - и помереть, не видев ничего. Нет уж.",
                        "Да и в поселении от меня толку меньше, чем кажется."];
                },
                ask: "Ещё?",
                opts: [
                    { label: "А если я тебя заведу на смерть?", go: "risk" },
                    { label: "Хорошо сказал.", do: ctx => { try { global.TFG_RELATIONS.note(cpOf(ctx).v, ctx.player, cpOf(ctx).s.id, 2, "похвалил спутника") } catch (e) { } }, go: null },
                ],
            },
            fear: {
                say: ["В пути боятся трёх вещей: воды, темноты и чужой стрелы.",
                      "Вода хуже всего. Упал - и уже не человек, а поклажа.",
                      "Я, впрочем, не утону: с тобой-то меня вытащит."],
                opts: [],
            },
            risk: {
                say: ctx => cpOathed(ctx)
                    ? ["Заведёшь - значит заведёшь. Мы с тобой связаны клятвой, и на Отмели мне будет с кем поговорить.",
                       "Это, если ты не знал, половина всего дела."]
                    : ["Тогда я лягу там, где лёг, и никто меня не помянёт. У меня с тобой нет узла.",
                       "Можно это поправить, если хочешь. Спроси отдельно."],
                note: ctx => cpOathed(ctx) ? null : "Он намекает на клятву.",
                opts: [],
            },
        },
    });

    // ─── Клятва на крови ───
    add({
        id: "cp_tk_oath",
        label: () => "Поклянёмся на крови",
        hint: () => "Связать себя узлом: по вере это держит душу - и он станет терпеливее.",
        show: ctx => !!cpOf(ctx) && !cpOathed(ctx),
        need: ctx => {
            try { return Number(global.TFG_RELATIONS.opinion(ctx.player, cpOf(ctx).v, cpOf(ctx).s)) >= 40 } catch (e) { return false }
        },
        start: "a",
        steps: {
            a: {
                say: ["Клятва на крови? Это не шутка, и после неё не разойдёшься, как расходятся наёмные.",
                      "Связи держат душу. У кого никого нет, тот на Отмели ждёт один, и ему никто не шепчет.",
                      "Если мы поклянёмся - у меня будет узел. И у тебя тоже, учти это."],
                ask: "Что скажешь?",
                opts: [
                    { label: "Клянусь.", hint: "Он станет терпеть голод до пяти дней вместо трёх.", go: "done" },
                    { label: "А что это даёт тебе?", go: "what" },
                    { label: "Повременим.", go: "later" },
                ],
            },
            what: {
                say: ["Мне - то, что меня помянут. Приношение у алтаря дойдёт, на обряде я смогу шепнуть.",
                      "А ещё я перестану считать дни, когда ты забываешь меня кормить. С узлом терпится дольше.",
                      "Тебе - то же самое, если ляжешь прежде меня."],
                ask: "Так что?",
                opts: [
                    { label: "Клянусь.", go: "done" },
                    { label: "Повременим.", go: "later" },
                ],
            },
            done: {
                say: ["Давай руку. Режь свою, я режу свою.",
                      "Всё. Теперь мы связаны, и развязывать это не вздумай - связь ослабнет, а это хуже, чем не клясться вовсе."],
                note: "Клятва дана: он будет терпеть голод до пяти дней.",
                do: ctx => {
                    var w = cpOf(ctx);
                    if (!w || !w.s.comp) return;
                    w.s.comp.oath = true;
                    try { global.TFG_RELATIONS.note(w.v, ctx.player, w.s.id, 15, "клятва на крови") } catch (e) { }
                    try { global.TFG_SETTLERS.save() } catch (e) { }
                    cpLog(w.s.name + " поклялся на крови с " + String(ctx.player.username));
                },
                opts: [],
            },
            later: {
                say: ["Как хочешь. Я не навязываюсь."],
                opts: [],
            },
        },
    });

    // ─── Что ты делаешь на базе ───
    add({
        id: "cp_tk_work",
        label: () => "Что ты делаешь на базе?",
        hint: () => "Чем он занят, пока тебя нет.",
        show: ctx => !!cpOf(ctx) && cpModeOf(ctx) === "база",
        start: "a",
        steps: {
            a: {
                say: ctx => {
                    var est = "простолюдины";
                    try { est = String(global.TFG_SETTLERS.estateOf(cpOf(ctx).s)) } catch (e) { }
                    if (est === "знать") return ["Я при деле. Когда приходит караван, я торгуюсь: беру самое дорогое, что по карману.",
                        "Монеты - из того сундука, где их больше всего. Из своих я не плачу, не надейся."];
                    if (est === "военные") return ["Стерегу. Хожу по кругу и смотрю, кто лезет.",
                        "Пока я тут, у тебя под стеной чужого не будет."];
                    return ["Жну, что поспело, и отношу в сундук, где зерно.",
                        "Недозрелое не трогаю - его трогать нельзя, пропадёт."];
                },
                ask: "Что уточнишь?",
                opts: [
                    { label: "А еда?", go: "food" },
                    { label: "Куда ты всё складываешь?", go: "where" },
                    { label: "Ясно.", go: null },
                ],
            },
            food: {
                say: ctx => cpHungryOf(ctx) > 0
                    ? ["Вот про еду и разговор. В хранилищах пусто, я " + cpHungryOf(ctx) + " день как не ел.",
                       "Положи чего-нибудь, иначе я уйду домой. " + (cpOathed(ctx) ? "С клятвой подожду до пятого дня." : "На третий день уйду.")]
                    : ["Ем дважды в сутки из хранилищ у базы. Беру самое сытное, что найду: похлёбку прежде сухой корки.",
                       "Пока есть что брать - я тут."],
                opts: [],
            },
            where: {
                say: ["Зерно и прочую снедь - в тот сундук, где зерна больше всего. Так проще искать потом.",
                      "Если зерна нигде нет, кладу туда, где больше места. Купленное у каравана - тоже.",
                      "Инструмент и руду не трогаю: не моё дело."],
                opts: [],
            },
        },
    });

    // ─── Если я тебя не сберегу ───
    add({
        id: "cp_tk_death",
        label: () => "Если я тебя не сберегу",
        hint: () => "Что он просит сделать с его телом.",
        show: ctx => !!cpOf(ctx),
        need: ctx => {
            try { return Number(global.TFG_RELATIONS.opinion(ctx.player, cpOf(ctx).v, cpOf(ctx).s)) >= 15 } catch (e) { return false }
        },
        start: "a",
        steps: {
            a: {
                say: ["Разговор нужный, и я рад, что ты спросил сам.",
                      "Лягу - сожги или зарой. До третьего дня. Больше ничего не надо."],
                ask: "Почему так строго?",
                opts: [
                    { label: "Почему до третьего дня?", go: "why" },
                    { label: "А если не успею?", go: "fail" },
                    { label: "Сделаю.", do: ctx => { try { global.TFG_RELATIONS.note(cpOf(ctx).v, ctx.player, cpOf(ctx).s.id, 3, "обещал упокоить") } catch (e) { } }, go: "promise" },
                ],
            },
            why: {
                say: ["Брошенное тело истлеет само, и душа отделится не так, как надо. Такая возвращается тварью.",
                      "И выйдет она не на чужих, а на тебя - ты ведь рядом будешь."],
                ask: "Ещё?",
                opts: [
                    { label: "А если не успею?", go: "fail" },
                    { label: "Сделаю.", do: ctx => { try { global.TFG_RELATIONS.note(cpOf(ctx).v, ctx.player, cpOf(ctx).s.id, 3, "обещал упокоить") } catch (e) { } }, go: "promise" },
                ],
            },
            fail: {
                say: ctx => cpOathed(ctx)
                    ? ["Тогда плохо, но не до конца. У нас с тобой клятва, а связь держит: меня хоть помянут.",
                       "Говорят, у кого связей много, того иногда и возвращают. Я на это не рассчитываю, но знать приятно."]
                    : ["Тогда совсем плохо. Ни узла, ни обряда - и никто меня не достанет.",
                       "Так что либо приходи за телом, либо давай клясться."],
                opts: [],
            },
            promise: {
                say: ctx => {
                    var est = "простолюдины";
                    try { est = String(global.TFG_SETTLERS.estateOf(cpOf(ctx).s)) } catch (e) { }
                    if (est === "знать") return ["Положи в камень, если будет камень. Если нет - огонь не хуже.",
                        "И не вздумай оставить меня в поле ради поклажи."];
                    if (est === "военные") return ["Я видел, что выходит из брошенных. Потому и говорю не как трус, а как знающий.",
                        "Руку мне разжимать не придётся - я привычный."];
                    return ["Вот и ладно. Мне больше ничего и не надо.",
                        "Дров-то возьми заранее. Их всегда не хватает именно тогда."];
                },
                opts: [],
            },
        },
    });

    cpLog("цепочки разговоров со спутником зарегистрированы: 4");
})()
