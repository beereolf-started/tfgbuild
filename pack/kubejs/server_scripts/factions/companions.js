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

function cpBaseStep(level, c, now) {
    var e = c.e, s = c.s, b = s.comp.base
    if (!b) return
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
    if ((s.comp.hungry || 0) >= 3) {
        try { seVoice(e, CP_HUNGRY_LEAVE) } catch (err) { }
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
