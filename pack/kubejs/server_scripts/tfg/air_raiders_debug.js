// priority: 0
"use strict";

/**
 * ОТЛАДКА ВОЗДУШНЫХ РЕЙДОВ: бандиты на аппаратах Immersive Aircraft 1.4.0.
 *
 * Проверено по байткоду IA и KubeJS:
 *  - пилот - первый пассажир; физику считает сервер, но VehicleEntity.tickPilot() каждый тик
 *    обнуляет ввод setInputs у пилота-не-игрока, поэтому ввод пишем прямо в сглаженные
 *    pressingInterpolatedX/Y/Z, которые читает updateController (airPush);
 *  - дирижабль и квадрокоптер заводит только игрок (canTurnOnEngine = instanceof Player),
 *    поэтому цель двигателя ставим сами (airEngine), а при появлении сразу поднимаем мощность
 *    (airKickEngine);
 *  - мощность = тяга * sqrt(доля заправленных котлов) - заправляем все котлы;
 *  - курс: yaw -= YAW_SPEED * X, вертикаль ~ Y, тяга ~ Z;
 *  - прочность 0..1, урон = урон / прочность / damagePerHealthPoint (30 в конфиге);
 *    ИГРОК В ТВОРЧЕСКОМ ломает аппарат любым попаданием - проверять в выживании;
 *  - имена функций сущностей - как отдаёт KubeJS (getYaw вместо getYRot и т.п.).
 *
 * Режим ai, состояния:
 *  drop   - аппарат с десантом (боевой дирижабль) летит к точке в AI_DROP_DIST от цели,
 *           снижается и высаживает всех, кроме пилота и стрелка;
 *  chase  - цель дальше AI_ENGAGE_OUT: летим к ней;
 *  engage - цель ближе AI_ENGAGE_IN: смотрит на аппарат - облёт, не смотрит - висим на радиусе;
 *  land   - прочность < AI_LAND_HEALTH: садимся с экипажем на ровную площадку, экипаж выходит
 *           (parked);
 *  pickup - отступление при свободных местах: садимся у своих пеших;
 *  board  - посадка: к аппарату бегут столько своих, сколько влезет, остальные воюют дальше;
 *  flee   - уходим от цели и исчезаем, когда никто не видит.
 * Отступление объявляется, когда здоровье всего рейда игрока (экипажи, десант и участники рейда
 * из tfg/raids.js) падает ниже AI_RETREAT_HEALTH от исходного.
 *
 * Команды (оператор):
 *  /tfgair spawn <airship|cargo_airship|warship|gyrodyne|quadrocopter|biplane>
 *                     - в воздухе в AIR_SPAWN_DIST блоках, сразу режим ai, все места заняты
 *  /tfgair mode <idle|hover|follow|circle|ai>
 *  /tfgair test <xplus|xminus|yplus|yminus|zplus|zminus|stop>  - ручной ввод
 *  /tfgair gunner    - посадить стрелка на свободное место последнего аппарата
 *  /tfgair flee      - сразу бегство
 *  /tfgair damage    - прочность 20% (в режиме ai начнётся посадка)
 *  /tfgair retreat   - объявить отступление рейда
 *  /tfgair yawflip | vflip | fuel | info | remove
 * В лог [tfg air] раз в 5 секунд пишется состояние каждого аппарата.
 */

const AIR_HEIGHTMAP = Java.loadClass("net.minecraft.world.level.levelgen.Heightmap$Types").MOTION_BLOCKING
const AIR_TYPES = ["airship", "cargo_airship", "warship", "gyrodyne", "quadrocopter", "biplane"]
const AIR_PILOT = "primitive_creatures:iloger_4"    // Засадник
const AIR_GUNNER = "primitive_creatures:iloger_5"   // Охотник
const AIR_TROOPS = ["primitive_creatures:iloger_4", "primitive_creatures:iloger_5", "primitive_creatures:iloger_6", "primitive_creatures:piloger_9"]
const AIR_FUEL = "tfg:fuel_barrel_diesel"
const AIR_DAMAGE_TAKEN = 0.35   // доля урона, которую аппарат рейдеров реально получает (airArmor)
const AIR_SPAWN_DIST = 56   // на каком расстоянии от игрока появляется аппарат
const AIR_ALT = 12          // высота над игроком в follow/circle
const AIR_ORBIT = 18        // радиус круга в circle
const AIR_TICK = 2          // расчёт управления раз в 2 тика (ввод - каждый тик)
const AIR_LOG_EVERY = 100   // лог раз в 5 секунд
const AIR_PI = 3.141592653589793

const AI_ENGAGE_IN = 40         // ближе - облёт/зависание у цели
const AI_ENGAGE_OUT = 64        // дальше - снова погоня
const AI_ORBIT_R = 24           // радиус облёта и зависания
const AI_ORBIT_LEAD = 0.35      // насколько вперёд по кругу целимся, радианы
const AI_ORBIT_THROTTLE = 0.7
const AI_ALT_MIN = 12           // высота над целью у цели: от
const AI_ALT_MAX = 22           // и до
const AI_CRUISE_ALT = 24        // высота над целью в погоне
const AI_FLEE_ALT = 40          // высота над целью при бегстве
const AI_CLEARANCE = 10         // запас над рельефом по курсу
// Рельеф проверяем плотно (узкий бамбук между редкими точками не проскочит), с запасом на ширину
// корпуса и немного позади: при зависании аппарат сдаёт назад.
const AI_PROBE_AHEAD = [0, 3, 6, 9, 12, 16, 20, 24, 32, 40, 48]
const AI_PROBE_BEHIND = [3, 6, 9, 12]
const AI_PROBE_SIDE = [-3, 0, 3]
// Бегство кончается исчезновением, как только ближайший игрок дальше AI_DESPAWN_DIST и никто
// аппарат не видит. Дальше дистанции симуляции сервера сущности не обрабатываются.
const AI_DESPAWN_DIST = 80
const AI_VIEW_DIST = 256
const AI_NEAR = 24              // ближе - видит всегда
const AI_VIEW_COS = 0.34        // ~70 градусов от взгляда
const AI_FOV_COS = 0.6          // "цель смотрит на аппарат" для облёта: ~53 градуса
const AI_SEEN_MEMORY = 40       // тиков облёта после того, как цель отвела взгляд
const AI_LAND_HEALTH = 0.25     // прочность ниже - посадка
const AI_LAND_SEARCH = 48       // радиус поиска ровной площадки
const AI_RETREAT_HEALTH = 0.35  // здоровье рейда ниже этой доли - отступление
const AI_BOARD_TIMEOUT = 600    // тиков на посадку, потом улетают с теми, кто успел
const AI_ALLY_RADIUS = 96       // своих дальше не ждём
const AI_DROP_DIST = 20         // десант высаживается в стольких блоках от цели
const AI_DROP_HEIGHT = 2.5      // и с такой высоты над землёй

var AIR_SERVER = null
var AIR_CRAFTS = []         // аппараты, см. airSpawn
var AIR_GROUND = []         // пешие из экипажей и десанта: { entity, owner }
var AIR_HP = {}             // uuid -> { e, owner, max, last } - здоровье всего рейда игрока
var AIR_RETREAT = {}        // игрок -> отступление уже объявлено
var AIR_capture = null      // { type, entity } - ловим сущность, созданную нашим summon

function airLog(msg) { global.tfgLog("tfg air", msg) }
function airWrap(a) { while (a > 180) a -= 360; while (a < -180) a += 360; return a }
function airClamp(v) { return v > 1 ? 1 : (v < -1 ? -1 : v) }

function airPlayer(name) {
	var found = null
	AIR_SERVER.players.forEach(p => { if (String(p.username) === name) found = p })
	return found
}

function airCraftsOf(player) {
	var name = String(player.username)
	return AIR_CRAFTS.filter(c => c.owner === name)
}

// событие появления срабатывает синхронно внутри summon - так получаем саму сущность
EntityEvents.spawned(event => {
	if (!AIR_capture || AIR_capture.entity) return
	try {
		if (String(event.entity.type) === AIR_capture.type) AIR_capture.entity = event.entity
	} catch (e) { }
})

function airSummon(level, type, x, y, z, tags) {
	AIR_capture = { type: type, entity: null }
	try {
		var nbt = tags ? " {Tags:[" + tags.map(t => '"' + t + '"').join(",") + "]}" : ""
		AIR_SERVER.runCommandSilent("execute in " + String(level.getDimension()) + " run summon " + type + " " + x + " " + y + " " + z + nbt)
		return AIR_capture.entity
	} finally {
		AIR_capture = null
	}
}

function airMount(rider, vehicle) {
	return Number(AIR_SERVER.runCommandSilent("ride " + String(rider.uuid) + " mount " + String(vehicle.uuid))) > 0
}

// живые пассажиры в порядке посадки: первый - пилот
function airPassengers(v) {
	var out = []
	var ps = v.getPassengers()
	for (var i = 0; i < ps.size(); i++) {
		var e = ps.get(i)
		try { if (e.isAlive()) out.push(e) } catch (err) { }
	}
	return out
}

// Первое существующее имя: setStackInSlot KubeJS добавляет любому Container, а setItem у аппарата
// объявлен в классе Immersive Aircraft и под этим именем может не найтись.
function airCall2(obj, names, a, b) {
	for (var i = 0; i < names.length; i++) if (typeof obj[names[i]] === "function") return obj[names[i]](a, b)
	throw "нет ни одной из функций " + names.join("/")
}

// itemId во все слоты типа type ("boiler", "upgrade")
function airFillSlots(vehicle, type, itemId) {
	var slots = vehicle.getInventoryDescription().getSlots(type)
	var n = 0
	for (var i = 0; slots && i < slots.size(); i++) {
		airCall2(vehicle, ["setStackInSlot", "kjs$setStackInSlot", "setItem", "m_6836_"], slots.get(i).index(), Item.of(itemId))
		n++
	}
	return n
}

function airRefuel(vehicle) {
	var n = airFillSlots(vehicle, "boiler", AIR_FUEL)
	return n > 0 ? "котлов заправлено: " + n : "котла нет"
}

// Живучесть без улучшений корпуса: аппарат получает только AIR_DAMAGE_TAKEN от урона. Перехватить удар
// IA не даёт, поэтому часть потерянной прочности возвращаем в том же тике сервера.
function airArmor(c) {
	var v = c.vehicle
	var h = Number(v.getHealth())
	if (c.lastHealth !== undefined && h < c.lastHealth && h > 0) {
		h = c.lastHealth - (c.lastHealth - h) * AIR_DAMAGE_TAKEN
		v.setHealth(h)
	}
	c.lastHealth = h
}

// ---- ввод и двигатель --------------------------------------------------------------------

// Приватные поля value/valueSmooth класса InterpolatedFloat: через них пишем ввод и мощность.
function airSmoothFields() {
	try {
		var cls = Java.loadClass("net.minecraft.world.item.ItemStack").EMPTY.getClass().getClassLoader()
			.loadClass("immersive_aircraft.util.InterpolatedFloat")
		var value = cls.getDeclaredField("value")
		var smooth = cls.getDeclaredField("valueSmooth")
		value.setAccessible(true)
		smooth.setAccessible(true)
		return { value: value, smooth: smooth }
	} catch (e) {
		airLog("поля InterpolatedFloat недоступны, ввод пойдёт через update(): " + e)
		return null
	}
}

const AIR_SMOOTH = airSmoothFields()

function airSetSmooth(f, target) {
	if (AIR_SMOOTH) {
		AIR_SMOOTH.value.setFloat(f, target)
		AIR_SMOOTH.smooth.setFloat(f, target)
	} else {
		for (var n = 0; n < 8; n++) f.update(target)
	}
}

// ввод - вне тика аппарата прямо в сглаженное значение, его прочтёт updateController
function airPush(c) {
	var v = c.vehicle
	airSetSmooth(v.pressingInterpolatedX, Number(c.inputs[0]))
	airSetSmooth(v.pressingInterpolatedY, Number(c.inputs[1]))
	airSetSmooth(v.pressingInterpolatedZ, Number(c.inputs[2]))
}

function airApply(c, x, y, z) {
	c.inputs = [x, y, z]
	c.vehicle.setInputs(x, y, z)
}

// Цель двигателя: IA её не сбрасывает, пока на борту есть пассажиры. Без топлива игра её не
// примет - бочка из котла становится топливом на первом тике с пассажиром. У биплана газ - ввод Y.
function airEngine(c) {
	if (c.type === "biplane") return
	var want = c.mode === "idle" ? 0 : 1
	if (Number(c.vehicle.getEngineTarget()) !== want) c.vehicle.setEngineTarget(want)
}

// первые секунды после появления - мощность сразу на максимум, чтобы аппарат не проваливался
function airKickEngine(c) {
	if (c.ticks > 80 || Number(c.vehicle.getEngineTarget()) < 1) return
	try { airSetSmooth(c.vehicle.enginePower, 1) } catch (e) { }
}

// ---- рейд: состав и здоровье ---------------------------------------------------------------

function airTrack(owner, e) {
	var id = String(e.uuid)
	var r = AIR_HP[id]
	if (!r) r = AIR_HP[id] = { e: e, owner: owner, max: 0, last: 0 }
	r.e = e
	try {
		if (e.isAlive()) {
			r.max = Math.max(r.max, Number(e.getMaxHealth()))
			r.last = Number(e.getHealth())
		} else {
			r.last = 0
		}
	} catch (err) { }
}

// активный рейд tfg/raids.js против этого игрока
function airRaidRecord(player) {
	if (!player || !global.TFG_ACTIVE_RAIDS) return null
	var uid = String(player.uuid)
	for (var id in global.TFG_ACTIVE_RAIDS) {
		var rec = global.TFG_ACTIVE_RAIDS[id]
		if (rec && String(rec.targetUUID) === uid) return rec
	}
	return null
}

// теги: bandit_roles.js выдаёт снаряжение по тиру и роли, raids.js берёт в участники по tfg_raid_id
function airCrewTags(player, kind) {
	var rec = airRaidRecord(player)
	// тир игрока и сложность - как у рейда (роли и выпадение, primitive_creatures/bandit_roles.js)
	var ptier = rec && rec.ptier ? rec.ptier : (global.TFG_PLAYER_TIER ? global.TFG_PLAYER_TIER(player) : 5)
	var diff = rec && rec.difficulty ? rec.difficulty : 1
	var tags = ["tfg_air_crew", "tfg_raid_tier:" + (rec ? rec.tier : Math.min(5, ptier)), "tfg_raid_ptier:" + ptier,
		"tfg_raid_diff:" + Math.round(diff * 100)]
	if (kind) tags.push("tfg_raid_kind:" + kind)
	if (rec) tags.push("tfg_raid", "tfg_raid_id:" + rec.id)
	return tags
}

// доля здоровья всего рейда игрока от исходного: погибшие считаются нулём
function airRaidHealth(name, player) {
	var rec = airRaidRecord(player)
	if (rec && player) {
		rec.members.forEach(u => {
			if (!u) return
			try {
				var e = player.level.getEntity(u)
				if (e) airTrack(name, e)
			} catch (err) { }
		})
	}
	var max = 0
	var now = 0
	for (var id in AIR_HP) {
		var r = AIR_HP[id]
		if (r.owner !== name) continue
		try { r.last = r.e.isAlive() ? Number(r.e.getHealth()) : 0 } catch (err) { r.last = 0 }
		max += r.max
		now += r.last
	}
	return max > 0 ? now / max : 1
}

// ---- появление -------------------------------------------------------------------------------

// новый член экипажа прямо в аппарат; не сел - убираем
function airBoardNew(c, player, entityType, kind) {
	var v = c.vehicle
	// модель игрока: хаск с типом бандита мода в теге (роль, звуки, добыча - primitive_creatures/bandit_roles.js)
	var e = airSummon(v.level, "minecraft:husk", Math.floor(v.getX()), Math.floor(v.getY()) + 1, Math.floor(v.getZ()),
		airCrewTags(player, kind).concat(["tfg_bandit", "tfg_bandit_type:" + entityType]))
	if (!e) return null
	if (!airMount(e, v)) {
		e.discard()
		return null
	}
	airTrack(c.owner, e)
	return e
}

function airSpawn(player, type) {
	var level = player.level
	var ang = Math.random() * 2 * AIR_PI
	var x = Math.floor(player.getX() + Math.cos(ang) * AIR_SPAWN_DIST)
	var z = Math.floor(player.getZ() + Math.sin(ang) * AIR_SPAWN_DIST)
	var ground = Number(level.getHeight(AIR_HEIGHTMAP, x, z))
	var y = Math.floor(Math.max(player.getY() + AI_CRUISE_ALT, ground + AI_CLEARANCE + 6))
	var vehicle = airSummon(level, "immersive_aircraft:" + type, x, y, z, null)
	if (!vehicle) return "аппарат " + type + " не появился"
	// yawSign -1: курс растёт при X < 0 (yaw -= YAW_SPEED * X)
	var c = {
		owner: String(player.username), type: type, vehicle: vehicle, pilot: null, gunners: [], aboard: [],
		seats: 1, mode: "ai", ai: "chase", inputs: [0, 0, 0], holdY: y,
		yawSign: -1, vSign: 1, score: 0, lastYaw: null, lastErr: 0, orbit: 0, ticks: 0,
		orbitDir: Math.random() < 0.5 ? 1 : -1, noLos: 0, lastSeen: -9999,
		land: null, dropAt: null, boarders: [], boardSince: 0, lastHealth: Number(vehicle.getHealth())
	}
	try { c.seats = Number(vehicle.getPassengerSpace()) } catch (e) { }
	c.pilot = airBoardNew(c, player, AIR_PILOT, null)
	if (!c.pilot) {
		vehicle.discard()
		return "пилот не сел - аппарат убран"
	}
	var fuel
	try { fuel = airRefuel(vehicle) } catch (e) { fuel = "заправка: ошибка " + e }
	// Улучшений корпуса нет: с разбитого или брошенного аппарата они достались бы игроку раньше времени.
	// Живучесть даёт скрипт (airArmor).
	var armor = "броня скриптом: урон x" + AIR_DAMAGE_TAKEN
	if (c.seats > 1) {
		var g = airBoardNew(c, player, AIR_GUNNER, "gunner")
		if (g) c.gunners.push(g)
	}
	var troops = 0
	for (var k = 2; k < c.seats; k++) {
		var troopType = AIR_TROOPS[Math.floor(Math.random() * AIR_TROOPS.length)]
		if (airBoardNew(c, player, troopType, Math.random() < 0.4 ? "gunner" : "melee")) troops++
	}
	if (troops > 0) c.ai = "drop"
	c.aboard = airPassengers(vehicle)
	AIR_CRAFTS.push(c)
	var rec = airRaidRecord(player)
	var msg = type + " в " + x + " " + y + " " + z + ": мест " + c.seats + ", пилот, стрелков " + c.gunners.length +
		", десант " + troops + ", " + fuel + ", " + armor + (rec ? ", в рейде " + rec.id : ", без рейда")
	airLog(player.username + ": " + msg)
	return msg
}

function airAddGunner(player) {
	var list = airCraftsOf(player)
	if (list.length === 0) return "нет ваших аппаратов - сначала /tfgair spawn"
	var c = list[list.length - 1]
	if (airPassengers(c.vehicle).length >= c.seats) return "мест нет (" + c.seats + ")"
	var g = airBoardNew(c, player, AIR_GUNNER, "gunner")
	if (!g) return "стрелок не сел"
	c.gunners.push(g)
	return "стрелок на борту"
}

// ---- простые отладочные режимы -------------------------------------------------------------

function airControl(c, owner) {
	if (c.mode === "manual") { airApply(c, c.inputs[0], c.inputs[1], c.inputs[2]); return }
	if (c.mode === "idle" || !owner) { airApply(c, 0, 0, 0); return }
	if (c.mode === "ai") { aiControl(c, owner); return }
	var v = c.vehicle
	var vx = v.getX()
	var vy = v.getY()
	var vz = v.getZ()
	var yaw = v.getYaw()

	// знак поворота подстраивается сам: восемь поворотов подряд не туда - знак меняется
	if (c.lastYaw !== null && Math.abs(c.inputs[0]) > 0.4) {
		var dYaw = airWrap(yaw - c.lastYaw)
		if (Math.abs(dYaw) > 0.3) {
			c.score += (dYaw * c.lastErr > 0) ? 1 : -1
			if (c.score > 8) c.score = 8
			if (c.score < -8) {
				c.yawSign = -c.yawSign
				c.score = 0
				airLog(c.type + ": знак поворота сам перевернулся на " + c.yawSign)
			}
		}
	}
	c.lastYaw = yaw

	var tx = vx, tz = vz, ty = c.holdY, fwd = 0
	if (c.mode === "follow" || c.mode === "circle") {
		ty = owner.getY() + AIR_ALT
		if (c.mode === "circle") {
			c.orbit += 0.03
			tx = owner.getX() + Math.cos(c.orbit) * AIR_ORBIT
			tz = owner.getZ() + Math.sin(c.orbit) * AIR_ORBIT
			fwd = 0.6
		} else {
			tx = owner.getX()
			tz = owner.getZ()
		}
	}
	var dx = tx - vx
	var dz = tz - vz
	var dist = Math.sqrt(dx * dx + dz * dz)
	if (c.mode === "follow") fwd = dist > 14 ? 1 : (dist > 8 ? 0.4 : 0)

	var x = 0
	if (c.mode !== "hover" && dist > 2) {
		var want = Math.atan2(-dx, dz) * 180 / AIR_PI
		var err = airWrap(want - yaw)
		c.lastErr = err
		x = airClamp(err / 25) * c.yawSign
		if (Math.abs(err) > 60) fwd = Math.min(fwd, 0.2)
	}
	var y = airClamp((ty - vy) / 4) * c.vSign
	airApply(c, x, y, fwd)
}

// ---- ИИ: рельеф и видимость ------------------------------------------------------------------

function aiTerrainNeed(level, x, z, yawDeg) {
	var r = yawDeg * AIR_PI / 180
	var fx = -Math.sin(r)
	var fz = Math.cos(r)
	var top = -9999
	var probe = d => {
		for (var k = 0; k < AI_PROBE_SIDE.length; k++) {
			var s = AI_PROBE_SIDE[k]
			// (fz, -fx) - вправо от курса
			var h = Number(level.getHeight(AIR_HEIGHTMAP, Math.floor(x + fx * d + fz * s), Math.floor(z + fz * d - fx * s)))
			if (h > top) top = h
		}
	}
	AI_PROBE_AHEAD.forEach(probe)
	AI_PROBE_BEHIND.forEach(d => probe(-d))
	return top + AI_CLEARANCE
}

// Застревание: тяга заметная, а за 40 тиков аппарат почти не сдвинулся - 60 тиков сдаём назад,
// набираем высоту и доворачиваем (aiControl), потом обычный курс.
function airStuckCheck(c) {
	var v = c.vehicle
	var x = v.getX()
	var z = v.getZ()
	if (c.mode !== "ai" || c.unstick > 0 || Math.abs(c.inputs[2]) < 0.3 || !c.lastPos) {
		c.lastPos = [x, z]
		c.stuck = 0
		return
	}
	var dx = x - c.lastPos[0]
	var dz = z - c.lastPos[1]
	c.lastPos = [x, z]
	c.stuck = Math.sqrt(dx * dx + dz * dz) < 0.05 ? (c.stuck || 0) + 1 : 0
	if (c.stuck >= 20) {
		c.stuck = 0
		c.unstick = 30
		airLog(c.type + ": упёрся в препятствие - назад и вверх")
	}
}

// смотрит ли игрок p на аппарат v: не дальше AI_VIEW_DIST, в конусе взгляда (cosLimit), без преград
function aiSeenBy(p, v, cosLimit) {
	var dx = v.getX() - p.getX()
	var dy = v.getY() - p.getEyeY()
	var dz = v.getZ() - p.getZ()
	var d = Math.sqrt(dx * dx + dy * dy + dz * dz)
	if (d > AI_VIEW_DIST || d < 0.1) return false
	var yaw = p.getYaw() * AIR_PI / 180
	var pitch = p.getPitch() * AIR_PI / 180
	var look = (-Math.sin(yaw) * Math.cos(pitch) * dx - Math.sin(pitch) * dy + Math.cos(yaw) * Math.cos(pitch) * dz) / d
	if (look < cosLimit) return false
	return p.hasLineOfSight(v)
}

// видит ли аппарат хоть один игрок (для исчезновения при бегстве); совсем рядом - видит всегда
function aiSeen(c) {
	var v = c.vehicle
	var dim = String(v.level.getDimension())
	var seen = false
	AIR_SERVER.players.forEach(p => {
		if (seen || String(p.level.getDimension()) !== dim) return
		var dx = v.getX() - p.getX()
		var dz = v.getZ() - p.getZ()
		if (Math.sqrt(dx * dx + dz * dz) < AI_NEAR || aiSeenBy(p, v, AI_VIEW_COS)) seen = true
	})
	return seen
}

function aiNearestPlayer(c) {
	var v = c.vehicle
	var dim = String(v.level.getDimension())
	var best = 1e9
	AIR_SERVER.players.forEach(p => {
		if (String(p.level.getDimension()) !== dim) return
		var dx = v.getX() - p.getX()
		var dz = v.getZ() - p.getZ()
		var d = Math.sqrt(dx * dx + dz * dz)
		if (d < best) best = d
	})
	return best
}

// ---- ИИ: площадки -------------------------------------------------------------------------

// ровная площадка вокруг (x, z): перепад не больше блока, не вода, не лава, не листва
function aiFlatAt(level, x, z, half, minY) {
	var h0 = Number(level.getHeight(AIR_HEIGHTMAP, x, z))
	if (h0 <= minY + 1) return null          // чанк не загружен - карта высот отдаёт дно мира
	var lo = h0
	var hi = h0
	for (var i = -half; i <= half; i++) {
		for (var j = -half; j <= half; j++) {
			var h = Number(level.getHeight(AIR_HEIGHTMAP, x + i, z + j))
			if (h < lo) lo = h
			if (h > hi) hi = h
			if (hi - lo > 1) return null
			// пустырь, а не крыша: на дома и стены не садимся (factions/structures.js)
			try { if (global.TFG_ON_ROOF && global.TFG_ON_ROOF(level, x + i, h, z + j)) return null } catch (e) { }
		}
	}
	var id = String(level.getBlock(x, h0 - 1, z).id)
	if (id.indexOf("water") >= 0 || id.indexOf("lava") >= 0 || id.indexOf("leaves") >= 0) return null
	return { x: x + 0.5, y: hi, z: z + 0.5 }
}

// ближайшая площадка: кольца через 4 блока до AI_LAND_SEARCH
function aiFindLanding(level, cx, cz, half) {
	var minY = Number(level.getMinBuildHeight())
	var bx = Math.floor(cx)
	var bz = Math.floor(cz)
	for (var r = 0; r <= AI_LAND_SEARCH; r += 4) {
		var best = null
		var bestD = 1e9
		for (var ix = -r; ix <= r; ix += 4) {
			for (var iz = -r; iz <= r; iz += 4) {
				if (Math.max(Math.abs(ix), Math.abs(iz)) !== r) continue
				var s = aiFlatAt(level, bx + ix, bz + iz, half, minY)
				if (s && ix * ix + iz * iz < bestD) {
					bestD = ix * ix + iz * iz
					best = s
				}
			}
		}
		if (best) return best
	}
	return null
}

function aiHalf(c) { return c.type === "warship" ? 3 : 2 }

// ---- ИИ: главный -----------------------------------------------------------------------------

function aiControl(c, owner) {
	if (c.unstick > 0) {
		c.unstick--
		airApply(c, 0.6 * c.orbitDir, 1, -0.4)
		return
	}
	var v = c.vehicle
	var vx = v.getX()
	var vy = v.getY()
	var vz = v.getZ()
	var yaw = v.getYaw()
	var ox = owner.getX()
	var oy = owner.getY()
	var oz = owner.getZ()
	var dx = ox - vx
	var dz = oz - vz
	var dist = Math.sqrt(dx * dx + dz * dz)

	// прочность ниже четверти - садимся вместе с экипажем (бегство и подбор своих - важнее)
	if (c.ai !== "land" && c.ai !== "pickup" && c.ai !== "flee" && Number(v.getHealth()) < AI_LAND_HEALTH) {
		c.ai = "land"
		c.land = aiFindLanding(v.level, vx, vz, aiHalf(c))
		airLog(c.type + ": прочность " + Math.round(Number(v.getHealth()) * 100) + "% - садится " +
			(c.land ? "на площадку " + Math.floor(c.land.x) + " " + c.land.y + " " + Math.floor(c.land.z) : "на месте: ровной площадки рядом нет"))
	}
	if (c.ai === "land" || c.ai === "pickup") {
		aiLand(c)
		return
	}
	if (c.ai === "drop") {
		aiDrop(c, owner)
		return
	}

	if (c.ai !== "flee") {
		if (dist > AI_ENGAGE_OUT) c.ai = "chase"
		else if (dist < AI_ENGAGE_IN) c.ai = "engage"
	}

	var tx, tz, ty, fwd
	var hold = false
	if (c.ai === "flee") {
		if (aiNearestPlayer(c) > AI_DESPAWN_DIST && !aiSeen(c)) {
			airLog(c.type + ": ушёл из виду в " + Math.round(dist) + " блоках от цели - убираю")
			airDespawn(c)
			return
		}
		var k = dist > 0.1 ? 100 / dist : 0
		tx = vx - dx * k
		tz = vz - dz * k
		ty = oy + AI_FLEE_ALT
		fwd = 1
	} else if (c.ai === "chase") {
		tx = ox
		tz = oz
		ty = oy + AI_CRUISE_ALT
		fwd = 1
	} else {
		// Цель смотрит на аппарат - облёт, уходим из прицела. Не смотрит - висим на радиусе и высоте,
		// чтобы стрелку было проще целиться. Облёт держится AI_SEEN_MEMORY тиков после взгляда.
		if (aiSeenBy(owner, v, AI_FOV_COS)) c.lastSeen = c.ticks
		ty = oy + (AI_ALT_MIN + AI_ALT_MAX) / 2
		if (c.ticks - c.lastSeen <= AI_SEEN_MEMORY) {
			var ang = Math.atan2(vz - oz, vx - ox) + c.orbitDir * AI_ORBIT_LEAD
			tx = ox + Math.cos(ang) * AI_ORBIT_R
			tz = oz + Math.sin(ang) * AI_ORBIT_R
			fwd = AI_ORBIT_THROTTLE
		} else {
			hold = true
			tx = ox
			tz = oz
			fwd = airClamp((dist - AI_ORBIT_R) / 8)   // дальше радиуса - вперёд, ближе - назад
		}
		if (c.gunners.length > 0) {
			var sees = true
			try { sees = c.gunners[0].hasLineOfSight(owner) } catch (e) { }
			if (!sees) {
				ty = oy + AI_ALT_MAX
				c.noLos++
				if (c.noLos > 60) {
					c.orbitDir = -c.orbitDir
					c.noLos = 0
				}
			} else {
				c.noLos = 0
			}
		}
	}

	var need = aiTerrainNeed(v.level, vx, vz, yaw)
	if (ty < need) ty = need
	var want = Math.atan2(-(tx - vx), tz - vz) * 180 / AIR_PI
	var err = airWrap(want - yaw)
	var x = airClamp(err / 25) * c.yawSign
	if (Math.abs(err) > 60) fwd = hold ? fwd * 0.3 : Math.min(fwd, 0.2)   // сначала развернуться
	if (need > vy + 4) fwd = Math.min(fwd, 0)          // впереди заметно выше нас - сначала набрать высоту на месте
	else if (need > vy + 1) fwd = Math.min(fwd, 0.2)
	var y = airClamp((ty - vy) / 4) * c.vSign
	airApply(c, x, y, fwd)
}

// Посадка на c.land (land - по прочности, pickup - за своими). На земле: land - экипаж выходит и
// аппарат стоит (parked); pickup - ждём назначенных (board).
function aiLand(c) {
	var v = c.vehicle
	var vx = v.getX()
	var vy = v.getY()
	var vz = v.getZ()
	var yaw = v.getYaw()
	if (!c.land) c.land = { x: vx, y: Number(v.level.getHeight(AIR_HEIGHTMAP, Math.floor(vx), Math.floor(vz))), z: vz }
	var hx = c.land.x - vx
	var hz = c.land.z - vz
	var d = Math.sqrt(hx * hx + hz * hz)
	if (d <= 3 && (v.onGround() || vy - c.land.y < 1.2)) {
		airApply(c, 0, 0, 0)
		if (c.ai === "pickup") {
			c.ai = "board"
			c.boardSince = c.ticks
			airLog(c.type + ": сел за своими, ждёт " + c.boarders.length)
		} else {
			c.mode = "idle"
			airEngine(c)
			airToGround(c, "сел на повреждённом аппарате", true)
			c.ai = "parked"
		}
		return
	}
	var x = 0
	var fwd = 0
	var ty = c.land.y
	if (d > 3) {
		ty = Math.max(c.land.y + 8, aiTerrainNeed(v.level, vx, vz, yaw))
		var err = airWrap(Math.atan2(-hx, hz) * 180 / AIR_PI - yaw)
		x = airClamp(err / 25) * c.yawSign
		fwd = Math.abs(err) > 60 ? 0.1 : airClamp(d / 12) * 0.8
	}
	var y = airClamp((ty - vy) / 4) * c.vSign
	if (d <= 3 && y < -0.5) y = -0.5   // над площадкой снижаемся плавно
	airApply(c, x, y, fwd)
}

// Десант: к точке в AI_DROP_DIST от цели, снизиться на AI_DROP_HEIGHT и высадить всех, кроме
// пилота и стрелка. Дальше - обычная погоня.
function aiDrop(c, owner) {
	var v = c.vehicle
	var vx = v.getX()
	var vy = v.getY()
	var vz = v.getZ()
	var yaw = v.getYaw()
	if (!c.dropAt) {
		var ax = vx - owner.getX()
		var az = vz - owner.getZ()
		var ad = Math.sqrt(ax * ax + az * az) || 1
		var px = owner.getX() + ax / ad * AI_DROP_DIST
		var pz = owner.getZ() + az / ad * AI_DROP_DIST
		c.dropAt = aiFindLanding(v.level, px, pz, 2) ||
			{ x: px, y: Number(v.level.getHeight(AIR_HEIGHTMAP, Math.floor(px), Math.floor(pz))), z: pz }
	}
	var hx = c.dropAt.x - vx
	var hz = c.dropAt.z - vz
	var d = Math.sqrt(hx * hx + hz * hz)
	var x = 0
	var fwd = 0
	var ty
	if (d > 5) {
		ty = Math.max(c.dropAt.y + 12, aiTerrainNeed(v.level, vx, vz, yaw))
		var err = airWrap(Math.atan2(-hx, hz) * 180 / AIR_PI - yaw)
		x = airClamp(err / 25) * c.yawSign
		fwd = Math.abs(err) > 60 ? 0.2 : airClamp(d / 16)
	} else {
		ty = c.dropAt.y + AI_DROP_HEIGHT
		if (vy - c.dropAt.y < AI_DROP_HEIGHT + 1.5) {
			airDropTroops(c)
			c.ai = "chase"
			return
		}
	}
	var y = airClamp((ty - vy) / 4) * c.vSign
	airApply(c, x, y, fwd)
}

function airDropTroops(c) {
	var ps = airPassengers(c.vehicle)
	var n = 0
	for (var i = 2; i < ps.length; i++) {
		ps[i].stopRiding()
		AIR_GROUND.push({ entity: ps[i], owner: c.owner })
		n++
	}
	c.gunners = ps.slice(1, 2)
	airLog(c.type + ": высадил десант - " + n)
}

function airDespawn(c) {
	var drop = e => { try { e.discard() } catch (err) { } }
	airPassengers(c.vehicle).forEach(drop)
	drop(c.vehicle)
	c.despawned = true
}

// Экипаж без аппарата. После посадки - выходит на 5 блоков в сторону (пустой аппарат IA сам сажает
// касающихся мобов). При крушении - падает как есть: сбили на высоте, значит разбились.
function airToGround(c, why, landed) {
	var v = c.vehicle
	var crew = landed ? airPassengers(v) : (c.aboard && c.aboard.length ? c.aboard : [c.pilot].concat(c.gunners))
	var n = 0
	for (var i = 0; i < crew.length; i++) {
		var e = crew[i]
		try {
			if (!e || !e.isAlive()) continue
			if (e.isPassenger()) e.stopRiding()
			if (landed) {
				var ang = i * 2.1
				var px = Math.floor(v.getX() + Math.cos(ang) * 5) + 0.5
				var pz = Math.floor(v.getZ() + Math.sin(ang) * 5) + 0.5
				var py = Number(v.level.getHeight(AIR_HEIGHTMAP, Math.floor(px), Math.floor(pz)))
				AIR_SERVER.runCommandSilent("execute in " + String(v.level.getDimension()) + " run tp " + String(e.uuid) + " " + px + " " + py + " " + pz)
			}
			AIR_GROUND.push({ entity: e, owner: c.owner })
			airTrack(c.owner, e)
			n++
		} catch (err) { }
	}
	c.pilot = null
	c.gunners = []
	c.aboard = []
	airLog(c.type + ": " + why + ", пеших из экипажа: " + n)
}

// ---- отступление ---------------------------------------------------------------------------

// свои пешие поблизости, ещё никем не назначенные на посадку, - ближние первыми
function airFreeAllies(c) {
	var v = c.vehicle
	var taken = {}
	AIR_CRAFTS.forEach(o => o.boarders.forEach(e => { taken[String(e.uuid)] = true }))
	var list = []
	for (var id in AIR_HP) {
		var r = AIR_HP[id]
		if (r.owner !== c.owner || taken[id]) continue
		try {
			if (!r.e.isAlive() || r.e.isPassenger()) continue
			var dx = r.e.getX() - v.getX()
			var dz = r.e.getZ() - v.getZ()
			var d2 = dx * dx + dz * dz
			if (d2 <= AI_ALLY_RADIUS * AI_ALLY_RADIUS) list.push({ e: r.e, d2: d2 })
		} catch (err) { }
	}
	list.sort((a, b) => a.d2 - b.d2)
	return list.map(o => o.e)
}

// Отступление для одного аппарата: свободные места и свои рядом - садимся за ними (стоящий - ждём
// их), берём не больше, чем влезет; иначе улетаем с теми, кто на борту.
function airStartRetreat(c) {
	if (c.ai === "flee" || c.ai === "board" || c.ai === "pickup") return
	var v = c.vehicle
	var free = c.seats - airPassengers(v).length
	var allies = free > 0 ? airFreeAllies(c) : []
	if (allies.length === 0) {
		if (c.ai === "parked") {
			airLog(c.type + ": отступление, но до аппарата добраться некому - брошен")
			c.despawned = true
			return
		}
		c.mode = "ai"
		c.ai = "flee"
		airLog(c.type + ": отступление - улетает")
		return
	}
	c.boarders = allies.slice(0, free)
	c.mode = "ai"
	if (c.ai === "parked") {
		c.ai = "board"
		c.boardSince = c.ticks
		airLog(c.type + ": отступление - к аппарату бегут " + c.boarders.length)
		return
	}
	var cx = 0
	var cz = 0
	c.boarders.forEach(e => { cx += e.getX(); cz += e.getZ() })
	c.land = aiFindLanding(v.level, cx / c.boarders.length, cz / c.boarders.length, aiHalf(c))
	c.ai = "pickup"
	airLog(c.type + ": отступление - садится забрать " + c.boarders.length)
}

// Посадка назначенных: бегут к аппарату и садятся (ride); все на борту или вышло время -
// первый пассажир берёт штурвал, и аппарат улетает.
function airBoardTick(c) {
	var v = c.vehicle
	c.boarders = c.boarders.filter(e => { try { return e.isAlive() } catch (err) { return false } })
	var running = 0
	c.boarders.forEach(e => {
		if (e.isPassenger()) return
		var dx = v.getX() - e.getX()
		var dz = v.getZ() - e.getZ()
		if (dx * dx + dz * dz < 9) {
			AIR_SERVER.runCommandSilent("ride " + String(e.uuid) + " mount " + String(v.uuid))
		} else {
			try { e.setTarget(null) } catch (err) { }
			e.getNavigation().moveTo(v.getX(), v.getY(), v.getZ(), 1.3)
			running++
		}
	})
	if (running > 0 && c.ticks - c.boardSince < AI_BOARD_TIMEOUT) return
	var aboard = airPassengers(v)
	if (aboard.length === 0) {
		airLog(c.type + ": лететь некому - аппарат брошен")
		c.despawned = true
		return
	}
	var ids = aboard.map(e => String(e.uuid))
	AIR_GROUND = AIR_GROUND.filter(g => ids.indexOf(String(g.entity.uuid)) < 0)
	c.pilot = aboard[0]
	c.gunners = aboard.slice(1)
	c.aboard = aboard
	c.boarders = []
	c.mode = "ai"
	c.ai = "flee"
	airEngine(c)
	airLog(c.type + ": на борту " + aboard.length + " - улетают")
}

// раз в секунду: здоровье рейда каждого игрока; ниже порога - отступление всех его аппаратов
function airRaidTick() {
	var owners = {}
	AIR_CRAFTS.forEach(c => { owners[c.owner] = true })
	AIR_GROUND.forEach(g => { owners[g.owner] = true })
	for (var name in owners) {
		if (AIR_RETREAT[name]) continue
		var ratio = airRaidHealth(name, airPlayer(name))
		if (ratio >= AI_RETREAT_HEALTH) continue
		AIR_RETREAT[name] = true
		airLog(name + ": у рейда осталось " + Math.round(ratio * 100) + "% здоровья - отступление")
		AIR_CRAFTS.forEach(c => { if (c.owner === name && (c.mode === "ai" || c.ai === "parked")) airStartRetreat(c) })
	}
	for (var id in AIR_HP) if (!owners[AIR_HP[id].owner]) delete AIR_HP[id]
	for (var n in AIR_RETREAT) if (!owners[n]) delete AIR_RETREAT[n]
}

// ---- стрельба и пешие ----------------------------------------------------------------------

// стрелки на борту - все, кроме пилота; линию огня на союзников проверяет raidTryShoot (tfg/raids.js)
function airGunners(c, owner) {
	if (!owner || typeof raidTryShoot !== "function") return
	for (var g = c.gunners.length - 1; g >= 0; g--) {
		var gun = c.gunners[g]
		if (!gun.isAlive()) { c.gunners.splice(g, 1); continue }
		if (!gun.hasLineOfSight(owner)) continue
		if (typeof raidBoardFire === "function") {
			raidBoardFire(gun, owner)     // лук, арбалет, дротик или ствол - у каждого свой темп (tfg/raids.js)
			continue
		}
		var dx = owner.getX() - gun.getX()
		var dy = owner.getY() - gun.getY()
		var dz = owner.getZ() - gun.getZ()
		raidTryShoot(gun, owner, dx * dx + dy * dy + dz * dz)
	}
}

// бежит на борт при отступлении - боевой ИИ рейда его не дёргает (tfg/raids.js, raidCombatTick)
function airIsBoarding(entity) {
	var id = String(entity.uuid)
	for (var i = 0; i < AIR_CRAFTS.length; i++) {
		var b = AIR_CRAFTS[i].boarders
		for (var j = 0; j < b.length; j++) if (String(b[j].uuid) === id) return true
	}
	return false
}

function airGroundTick() {
	var boarding = {}
	AIR_CRAFTS.forEach(c => c.boarders.forEach(e => { boarding[String(e.uuid)] = true }))
	for (var i = AIR_GROUND.length - 1; i >= 0; i--) {
		var g = AIR_GROUND[i]
		try {
			if (!g.entity.isAlive()) {
				AIR_GROUND.splice(i, 1)
				continue
			}
			if (boarding[String(g.entity.uuid)]) continue     // бегут к аппарату - не отвлекаются
			if (g.entity.isPassenger()) g.entity.stopRiding()  // пустой аппарат IA сам сажает касающихся
			var owner = airPlayer(g.owner)
			if (!owner) continue
			if (typeof raidCombatTick === "function") {
				// пешие из рейда - под tickRaidMember (tfg/raids.js); остальные - тот же боевой ИИ отсюда
				if (!raidManaged(g.entity)) raidCombatTick(g.entity, owner)
				continue
			}
			g.entity.setTarget(owner)
			if (typeof raidTryShoot === "function" && g.entity.hasLineOfSight(owner)) {
				var dx = owner.getX() - g.entity.getX()
				var dy = owner.getY() - g.entity.getY()
				var dz = owner.getZ() - g.entity.getZ()
				raidTryShoot(g.entity, owner, dx * dx + dy * dy + dz * dz)
			}
		} catch (e) {
			AIR_GROUND.splice(i, 1)
		}
	}
}

// ---- состояние, уборка -----------------------------------------------------------------------

function airStatus(c) {
	var v = c.vehicle
	var s = c.type + " [" + c.mode + (c.mode === "ai" || c.ai === "parked" ? ":" + c.ai : "") + "] " +
		Math.round(v.getX()) + " " + Math.round(v.getY()) + " " + Math.round(v.getZ())
	try { s += " | двигатель " + Number(v.getEnginePower()).toFixed(2) + "/" + Number(v.getEngineTarget()).toFixed(2) } catch (e) { }
	try { s += " | топливо " + Number(v.getFuelUtilization()).toFixed(2) } catch (e) { }
	try { s += " | прочность " + Math.round(Number(v.getHealth()) * 100) + "% (запас x" + Number(v.getDurability()).toFixed(0) + ")" } catch (e) { }
	try { s += " | борт " + airPassengers(v).length + "/" + c.seats } catch (e) { }
	s += " | ввод " + c.inputs.map(n => Number(n).toFixed(2)).join(" ")
	try {
		s += " | в управлении " + [v.pressingInterpolatedX, v.pressingInterpolatedY, v.pressingInterpolatedZ]
			.map(f => Number(f.getSmooth()).toFixed(2)).join(" ")
	} catch (e) { }
	try { s += " | рейд " + Math.round(airRaidHealth(c.owner, airPlayer(c.owner)) * 100) + "%" } catch (e) { }
	return s
}

function airRemove(player) {
	var name = String(player.username)
	var kill = e => {
		try { e.discard() } catch (err) {
			try { AIR_SERVER.runCommandSilent("kill " + String(e.uuid)) } catch (err2) { }
		}
	}
	var list = airCraftsOf(player)
	list.forEach(c => {
		airPassengers(c.vehicle).forEach(kill)
		kill(c.vehicle)
	})
	var ground = AIR_GROUND.filter(g => g.owner === name)
	ground.forEach(g => kill(g.entity))
	AIR_CRAFTS = AIR_CRAFTS.filter(c => c.owner !== name)
	AIR_GROUND = AIR_GROUND.filter(g => g.owner !== name)
	for (var id in AIR_HP) if (AIR_HP[id].owner === name) delete AIR_HP[id]
	delete AIR_RETREAT[name]
	return "убрано аппаратов: " + list.length + ", пеших: " + ground.length
}

// ---- тик ----------------------------------------------------------------------------------

ServerEvents.tick(event => {
	if (!AIR_SERVER) AIR_SERVER = event.server
	if (AIR_CRAFTS.length === 0 && AIR_GROUND.length === 0) return
	var tick = Number(event.server.tickCount)
	var controlTick = tick % AIR_TICK === 0
	for (var i = AIR_CRAFTS.length - 1; i >= 0; i--) {
		var c = AIR_CRAFTS[i]
		try {
			if (!c.vehicle.isAlive()) {
				var reason = ""
				try { reason = String(c.vehicle.getRemovalReason()) } catch (err) { }
				if (reason.indexOf("UNLOADED") >= 0) airLog(c.type + " выгружен вместе с чанком - убираю из отладки")
				else if (c.ai === "parked") airLog(c.type + ": аппарат на стоянке разрушен")
				else airToGround(c, "аппарат разрушен, экипаж падает", false)
				AIR_CRAFTS.splice(i, 1)
				continue
			}
			airArmor(c)
			// на стоянке или ждёт своих: управление не нужно, ввод не пишем
			if (c.ai === "parked" || c.ai === "board") {
				if (controlTick) {
					c.ticks += AIR_TICK
					airEngine(c)
					if (c.ai === "board") airBoardTick(c)
					if (c.ticks % AIR_LOG_EVERY === 0) airLog(airStatus(c))
				}
				if (c.despawned) AIR_CRAFTS.splice(i, 1)
				continue
			}
			if (controlTick) {
				c.aboard = airPassengers(c.vehicle)
				// пилот погиб или выпал - штурвал берёт следующий на борту; никого нет - аппарат падает
				if (!c.pilot || !c.pilot.isAlive() || !c.pilot.isPassenger()) {
					if (c.aboard.length === 0) {
						airLog(c.type + ": на борту никого - аппарат без управления")
						AIR_CRAFTS.splice(i, 1)
						continue
					}
					c.pilot = c.aboard[0]
					c.gunners = c.aboard.slice(1)
					airLog(c.type + ": пилот выбыл, за штурвалом " + c.pilot.getType())
				}
				var owner = airPlayer(c.owner)
				airControl(c, owner)
				if (c.despawned) {
					AIR_CRAFTS.splice(i, 1)
					continue
				}
				airEngine(c)
				airKickEngine(c)
				airGunners(c, owner)
				airStuckCheck(c)
			}
			airPush(c)
			if (controlTick) {
				c.ticks += AIR_TICK
				if (c.ticks % AIR_LOG_EVERY === 0) airLog(airStatus(c))
			}
		} catch (e) {
			// одна запись на аппарат, а не 20 в секунду
			if (c.lastError !== String(e)) {
				c.lastError = String(e)
				global.tfgLogError("tfg air", "тик аппарата " + c.type, e)
			}
		}
	}
	if (controlTick) airGroundTick()
	if (tick % 20 === 0) {
		try { airRaidTick() } catch (e) { global.tfgLogError("tfg air", "проверка рейда", e) }
	}
})

// ---- команды ------------------------------------------------------------------------------

ServerEvents.commandRegistry(event => {
	var Commands = event.commands
	// у KubeJS sendSuccess принимает готовый текст; штатный sendSuccess(Supplier) скрыт
	var reply = (ctx, msg) => ctx.source.sendSuccess(Text.of(msg), false)
	var run = (ctx, fn) => {
		try {
			var p = ctx.source.getPlayerOrException()
			if (!AIR_SERVER) AIR_SERVER = p.getServer()
			fn(p)
		} catch (e) {
			global.tfgLogError("tfg air", "команда /tfgair", e)
			ctx.source.sendFailure(Text.of("Ошибка /tfgair: " + String(e).substring(0, 300)))
		}
		return 1
	}

	var root = Commands.literal("tfgair").requires(src => src.hasPermission(2))

	var spawn = Commands.literal("spawn")
	AIR_TYPES.forEach(t => {
		spawn = spawn.then(Commands.literal(t).executes(ctx => run(ctx, p => reply(ctx, airSpawn(p, t)))))
	})
	root = root.then(spawn)

	var mode = Commands.literal("mode")
	var modes = ["idle", "hover", "follow", "circle", "ai"]
	modes.forEach(m => {
		mode = mode.then(Commands.literal(m).executes(ctx => run(ctx, p => {
			var list = airCraftsOf(p)
			list.forEach(c => {
				c.mode = m
				if (m === "hover") c.holdY = c.vehicle.getY() + 6
				if (m === "ai" && c.ai !== "parked") c.ai = "chase"
				airEngine(c)
			})
			reply(ctx, "режим " + m + " для аппаратов: " + list.length)
			list.forEach(c => reply(ctx, airStatus(c)))
		})))
	})
	root = root.then(mode)

	var presets = { xplus: [1, 0, 0], xminus: [-1, 0, 0], yplus: [0, 1, 0], yminus: [0, -1, 0], zplus: [0, 0, 1], zminus: [0, 0, -1], stop: [0, 0, 0] }
	var test = Commands.literal("test")
	Object.keys(presets).forEach(k => {
		test = test.then(Commands.literal(k).executes(ctx => run(ctx, p => {
			var list = airCraftsOf(p)
			list.forEach(c => {
				c.mode = "manual"
				c.inputs = presets[k].slice()
				airEngine(c)
				airPush(c)
			})
			reply(ctx, "ручной ввод " + k + " (x y z = " + presets[k].join(" ") + ") для аппаратов: " + list.length)
			list.forEach(c => reply(ctx, airStatus(c)))
		})))
	})
	root = root.then(test)

	root = root
		.then(Commands.literal("gunner").executes(ctx => run(ctx, p => reply(ctx, airAddGunner(p)))))
		.then(Commands.literal("flee").executes(ctx => run(ctx, p => {
			var list = airCraftsOf(p)
			list.forEach(c => { c.mode = "ai"; c.ai = "flee"; airEngine(c) })
			reply(ctx, "бегство для аппаратов: " + list.length)
		})))
		.then(Commands.literal("damage").executes(ctx => run(ctx, p => {
			var list = airCraftsOf(p)
			list.forEach(c => { c.vehicle.setHealth(0.2); c.lastHealth = 0.2 })
			reply(ctx, "прочность 20% для аппаратов: " + list.length + " (в режиме ai начнётся посадка)")
		})))
		.then(Commands.literal("retreat").executes(ctx => run(ctx, p => {
			var name = String(p.username)
			AIR_RETREAT[name] = true
			var list = airCraftsOf(p)
			list.forEach(c => airStartRetreat(c))
			reply(ctx, "отступление рейда: аппаратов " + list.length)
		})))
		.then(Commands.literal("yawflip").executes(ctx => run(ctx, p => {
			airCraftsOf(p).forEach(c => { c.yawSign = -c.yawSign; c.score = 0 })
			reply(ctx, "знак поворота перевёрнут")
		})))
		.then(Commands.literal("vflip").executes(ctx => run(ctx, p => {
			airCraftsOf(p).forEach(c => { c.vSign = -c.vSign })
			reply(ctx, "знак высоты перевёрнут")
		})))
		.then(Commands.literal("fuel").executes(ctx => run(ctx, p => {
			var list = airCraftsOf(p)
			list.forEach(c => reply(ctx, c.type + ": " + airRefuel(c.vehicle)))
			if (list.length === 0) reply(ctx, "нет ваших аппаратов")
		})))
		.then(Commands.literal("info").executes(ctx => run(ctx, p => {
			var list = airCraftsOf(p)
			if (list.length === 0) reply(ctx, "нет ваших аппаратов")
			list.forEach(c => reply(ctx, airStatus(c)))
		})))
		.then(Commands.literal("remove").executes(ctx => run(ctx, p => reply(ctx, airRemove(p)))))

	event.register(root)
	airLog("/tfgair зарегистрирован")
})
