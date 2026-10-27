// priority: 0
"use strict";

/**
 * УКРОТИТЕЛЬ ЗВЕРЕЙ (primitive_creatures:wiloger): меньше спама, больше разнообразия.
 *
 * Как устроено в моде (primitive_creatures 2.7, по байткоду): укротитель бросает
 * снаряд primitive_creatures:ww_4, и КАЖДОЕ его попадание (WW4Entity.onHitEntity ->
 * W6665Procedure) создаёт Зверя в точке попадания. Сколько бросков попало - столько
 * и зверей, отсюда спам.
 *
 * Здесь перехватывается появление Зверя, рядом с которым есть укротитель:
 *  - не чаще раза в минуту на участок 32x32 и не больше 2 питомцев рядом -
 *    лишнее появление отменяется (EntityEvents.spawned отменяем: KubeJS отдаёт
 *    результат в Architectury EntityEvent.ADD);
 *  - ночью вместо Зверя иногда приходит тролль (днём тролли Ice and Fire каменеют
 *    на солнце), днём - иногда циклоп.
 * Звери из обычного спавна мира, без укротителя рядом, не трогаются.
 *
 * Время суток и поиск места - iafDayTime/iafFindSpot из iceandfire/danger_spawns.js.
 */

const TAMER_ID = "primitive_creatures:wiloger"
const TAMER_BEAST_ID = "primitive_creatures:beast"
const TAMER_RADIUS = 40
const TAMER_COOLDOWN = 1200              // тиков на участок: 60 с
const TAMER_MAX_PETS = 2
const TAMER_TROLL_CHANCE_NIGHT = 0.35
const TAMER_CYCLOPS_CHANCE_DAY = 0.25
const TAMER_PET_TAG = "tfg_tamer_pet"

var TAMER_SERVER = null
var TAMER_lastSummon = {}   // "измерение|x|z" участка -> тик
var TAMER_queue = []        // замены, которые ставятся на следующем тике

function tamerLog(msg) { global.tfgLog("tfg tamer", msg) }

function tamerCount(dim, x, y, z, selector) {
	return Number(TAMER_SERVER.runCommandSilent("execute in " + dim + " positioned " + x + " " + y + " " + z + " if entity " + selector))
}

/** "keep" - оставить Зверя, "cancel" - отменить (замена, если выпала, уже в очереди). */
function tamerDecide(beast) {
	if (!TAMER_SERVER) return "keep"
	var level = beast.level
	// getDimension() явно: у уровня есть и метод игры dimension(), .dimension отдал бы его
	var dim = String(level.getDimension())
	var x = Math.floor(beast.getX())
	var y = Math.floor(beast.getY())
	var z = Math.floor(beast.getZ())
	if (tamerCount(dim, x, y, z, "@e[type=" + TAMER_ID + ",distance=.." + TAMER_RADIUS + "]") <= 0) return "keep"

	var tick = Number(TAMER_SERVER.tickCount)
	var key = dim + "|" + Math.floor(x / 32) + "|" + Math.floor(z / 32)
	var pets = tamerCount(dim, x, y, z, "@e[tag=" + TAMER_PET_TAG + ",distance=.." + TAMER_RADIUS + "]")
	var last = TAMER_lastSummon[key]
	if ((last !== undefined && tick - last < TAMER_COOLDOWN) || pets >= TAMER_MAX_PETS) return "cancel"
	TAMER_lastSummon[key] = tick

	var dayTime = null
	try { dayTime = iafDayTime(TAMER_SERVER, level) } catch (e) { }
	var night = dayTime !== null && (dayTime % 24000) >= 13000
	var replacement = null
	if (night && Math.random() < TAMER_TROLL_CHANCE_NIGHT) replacement = "iceandfire:troll"
	else if (dayTime !== null && !night && Math.random() < TAMER_CYCLOPS_CHANCE_DAY) replacement = "iceandfire:cyclops"

	if (replacement) {
		TAMER_queue.push({ level: level, dim: dim, x: x, z: z, type: replacement })
		return "cancel"
	}
	beast.getTags().add(TAMER_PET_TAG)
	return "keep"
}

EntityEvents.spawned(event => {
	var ent = event.entity
	if (String(ent.type) !== TAMER_BEAST_ID) return
	var decision = "keep"
	try {
		decision = tamerDecide(ent)
	} catch (e) {
		global.tfgLogError("tfg tamer", "разбор появления зверя", e)
	}
	// вне try: cancel() в KubeJS прерывает обработчик исключением-выходом
	if (decision === "cancel") event.cancel()
})

// Замена ставится на следующем тике: создавать моба прямо внутри события появления
// другого моба небезопасно.
ServerEvents.tick(event => {
	if (!TAMER_SERVER) TAMER_SERVER = event.server
	if (TAMER_queue.length === 0) return
	var jobs = TAMER_queue
	TAMER_queue = []
	for (var i = 0; i < jobs.length; i++) {
		var job = jobs[i]
		try {
			var spot = iafFindSpot(job.level, job.x, job.z, job.type, 2, 6, true)
			if (!spot) continue
			var at = "execute in " + job.dim + " positioned " + spot.x + " " + spot.y + " " + spot.z + " run "
			if (Number(event.server.runCommandSilent(at + "summon " + job.type)) > 0) {
				event.server.runCommandSilent(at + "tag @e[type=" + job.type + ",distance=..3,limit=1,sort=nearest] add " + TAMER_PET_TAG)
				tamerLog("укротитель призвал " + job.type + " в " + spot.x + " " + spot.y + " " + spot.z)
			}
		} catch (e) {
			global.tfgLogError("tfg tamer", "замена зверя на " + job.type, e)
		}
	}
})
