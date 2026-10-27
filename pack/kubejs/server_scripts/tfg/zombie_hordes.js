// priority: 0
"use strict";

/**
 * НОЧНЫЕ ОРДЫ ЗОМБИ - по образцу рейдов разбойников (tfg/raids.js), но проще:
 * толпа не ищет укрытий и не нуждается в своём ИИ, ей хватает штатного.
 *
 *  - только ночью, примерно раз в два месяца календаря TFC (срок - в данных игрока);
 *  - на сутки принудительно включается гроза;
 *  - от HORDE_MIN до HORDE_MAX зомби вокруг игрока;
 *  - каждому: скорость, дальность обнаружения и ВЫСОТА ШАГА.
 *
 * ПРО "ЗАЛАЗИТЬ НА УСТУПЫ": ParCool для этого не годится - проверено по
 * байткоду, его капабилити Parkourability вешается в AttachCapabilityHandler
 * ТОЛЬКО на Player, и все действия завязаны на ввод с клавиатуры. Мобам он
 * недоступен в принципе.
 *
 * Вместо него - forge:step_height_addition (атрибут из ForgeMod.STEP_HEIGHT_ADDITION).
 * Он прибавляется к базовой высоте шага 0.6, то есть при +1.5 зомби спокойно
 * заходит на уступ в 2 блока, как на ступеньку. Выглядит это не как подтягивание,
 * а как "перешагнул" - зато работает на любом мобе и без единого мода.
 *
 * Файл самодостаточный: свои события вешает сам.
 */

const HORDE_MIN = 20
const HORDE_MAX = 50
// Орда приходит к игроку примерно раз в два месяца календаря TFC: срок следующей - случайно через
// HORDE_MONTHS_MIN..HORDE_MONTHS_MAX месяцев после прошлой, сама орда ждёт ночи. Раньше - 25% каждую ночь.
const HORDE_MONTHS_MIN = 1.5
const HORDE_MONTHS_MAX = 2.5
const HORDE_Calendars = Java.loadClass("net.dries007.tfc.util.calendar.Calendars")
const HORDE_SPAWN_MIN_DIST = 24      // на таком удалении выбирается точка сбора
const HORDE_SPAWN_MAX_DIST = 48
const HORDE_CLUSTER_RADIUS = 7       // радиус самого скопления вокруг точки сбора
const HORDE_WEATHER_TICKS = 24000    // сутки грозы
const HORDE_CHECK_INTERVAL = 200     // раз в 10 сек проверяем, наступила ли ночь
const HORDE_NIGHT_FROM = 13000       // ночь по dayTime % 24000

/**
 * Прибавка к высоте шага. База у мобов 0.6, значит:
 *   +1.5 -> 2.1 - заходит на уступ в 2 блока
 *   +2.5 -> 3.1 - и на три
 */
const HORDE_STEP_HEIGHT = 1.5
const HORDE_SPEED_BONUS = 0.35       // +35% скорости
const HORDE_FOLLOW_RANGE = 48        // чтобы дошли от точки спавна

const HORDE_MOB = 'minecraft:zombie'
const HORDE_MOTION_BLOCKING = Java.loadClass("net.minecraft.world.level.levelgen.Heightmap$Types").MOTION_BLOCKING

var HORDE_SERVER = null

function hordeLog(msg) {
	global.tfgLog("tfg horde", msg)
}
function hordeErr(msg, e) {
	global.tfgLogError("tfg horde", msg, e)
}

function hordeToday() {
	return Number(HORDE_Calendars.SERVER.getTotalCalendarDays())
}

function hordeInterval() {
	var month = Math.max(1, Number(HORDE_Calendars.SERVER.getCalendarDaysInMonth()))
	return Math.round(month * (HORDE_MONTHS_MIN + Math.random() * (HORDE_MONTHS_MAX - HORDE_MONTHS_MIN)))
}

/** День, раньше которого орды у игрока не будет; впервые - обычный срок от сегодня. */
function hordeNextDay(player, today) {
	var pd = player.persistentData
	if (!pd.contains('tfg_horde_next_day')) {
		pd.putLong('tfg_horde_next_day', today + hordeInterval())
		hordeLog(player.username + ": следующая орда - не раньше дня " + Number(pd.getLong('tfg_horde_next_day')))
	}
	return Number(pd.getLong('tfg_horde_next_day'))
}

function hordeAnnounce(name, size) {
	HORDE_SERVER.runCommandSilent(
		'tellraw @a[name=' + name + '] [{"text":"[Орда] ","color":"dark_red","bold":true},{"text":"Мертвецы идут на запах живого. Их около ' + size + '.","color":"red"}]'
	)
	HORDE_SERVER.runCommandSilent('title @a[name=' + name + '] times 10 90 20')
	HORDE_SERVER.runCommandSilent('title @a[name=' + name + '] subtitle {"text":"Переживи эту ночь","color":"gold"}')
	HORDE_SERVER.runCommandSilent('title @a[name=' + name + '] title {"text":"ОРДА","color":"dark_red","bold":true}')
}

function spawnHorde(player) {
	var name = player.username
	var level = player.level
	var size = HORDE_MIN + Math.floor(Math.random() * (HORDE_MAX - HORDE_MIN + 1))
	var id = String(Math.floor(Math.random() * 100000))

	// гроза на сутки - зомби не сгорят на рассвете и атмосфера та самая
	HORDE_SERVER.runCommandSilent('weather thunder ' + HORDE_WEATHER_TICKS)

	var px = Math.floor(player.getX())
	var pz = Math.floor(player.getZ())
	var spawned = 0

	// Орда приходит СКОПЛЕНИЕМ с одной стороны, а не оцеплением по кругу:
	// выбираем одну точку сбора неподалёку и рассыпаем всех вокруг неё.
	var groupAngle = Math.random() * 2 * 3.141592653589793
	var groupDist = HORDE_SPAWN_MIN_DIST + Math.random() * (HORDE_SPAWN_MAX_DIST - HORDE_SPAWN_MIN_DIST)
	var groupCx = px + Math.round(Math.cos(groupAngle) * groupDist)
	var groupCz = pz + Math.round(Math.sin(groupAngle) * groupDist)
	hordeLog(name + ": точка сбора x=" + groupCx + " z=" + groupCz + " (в " + Math.round(groupDist) + " блоках)")

	for (var i = 0; i < size; i++) {
		// равномерно по кругу-пятну: sqrt даёт ровную плотность, без комка в центре
		var ang = Math.random() * 2 * 3.141592653589793
		var r = HORDE_CLUSTER_RADIUS * Math.sqrt(Math.random())
		var sx = groupCx + Math.round(Math.cos(ang) * r)
		var sz = groupCz + Math.round(Math.sin(ang) * r)
		if (isNaN(sx) || isNaN(sz)) continue
		var sy = level.getHeight(HORDE_MOTION_BLOCKING, sx, sz)

		var cmd = 'execute as ' + name + ' at @s run summon ' + HORDE_MOB +
			' ' + sx + ' ' + sy + ' ' + sz +
			' {Tags:["tfg_managed","tfg_zombie_horde","tfg_horde_id:' + id + '"],PersistenceRequired:1b}'
		try {
			if (HORDE_SERVER.runCommandSilent(cmd) > 0) spawned++
		} catch (e) {
			hordeErr("summon #" + i, e)
		}
	}

	hordeAnnounce(name, spawned)
	hordeLog(name + ": орда " + id + " - заказано " + size + ", заспавнено " + spawned + ", гроза на " + HORDE_WEATHER_TICKS + " тиков")
	return spawned > 0
}

// ─── Экипировка орды: скорость, дальнозоркость, высота шага ────────────────────

EntityEvents.spawned(event => {
	try {
		var entity = event.entity
		// перебором, а не .contains(): ровно так читает теги raids.js, и это
		// доказанно работает на мобах из /summon
		var isHorde = false
		var it = entity.getTags().iterator()
		while (it.hasNext()) {
			if (String(it.next()) === 'tfg_zombie_horde') { isHorde = true; break }
		}
		if (!isHorde) return
		if (entity.persistentData.getBoolean('tfg_horde_buffed')) return

		entity.modifyAttribute('minecraft:generic.movement_speed', 'tfg_horde_speed', HORDE_SPEED_BONUS, 'multiply_total')
		entity.modifyAttribute('minecraft:generic.follow_range', 'tfg_horde_range', HORDE_FOLLOW_RANGE, 'addition')
		// ради этого всё и затевалось - зомби перешагивает уступы
		entity.modifyAttribute('forge:step_height_addition', 'tfg_horde_step', HORDE_STEP_HEIGHT, 'addition')
		entity.persistentData.putBoolean('tfg_horde_buffed', true)
	} catch (e) {
		hordeErr("не удалось усилить зомби " + event.entity, e)
	}
})

// ─── Ночная проверка ───────────────────────────────────────────────────────────

/**
 * Время суток мира - только явным вызовом и с проверкой, что вышло число.
 *
 * ПОЧЕМУ НЕ .dayTime. В таблице имён Rhino (mm.jsmappings) у уровня есть и
 * метод getDayTime(), и отдельный метод dayTime() (из LevelTimeAccess). Поэтому
 * обращение .dayTime отдаёт сам МЕТОД, а не число: dayTime % 24000 = NaN, и
 * pd.putLong(NaN) падал "Cannot convert NaN to java.lang.Long" на каждой
 * проверке раз в 10 секунд (лог KubeJS, zombie_hordes.js#160). Орда при этом
 * не приходила ни разу.
 *
 * Запасной путь - спросить у самой игры: /time query day и /time query daytime
 * возвращают число результатом команды, а runCommandSilent отдаёт его как int.
 */
var HORDE_clockWarned = false

function hordeDayTime(server, level) {
	var t = NaN
	try { t = Number(level.getDayTime()) } catch (e) { /* ниже - запасной путь */ }
	if (isFinite(t)) return t
	try {
		var day = Number(server.runCommandSilent('time query day'))
		var tod = Number(server.runCommandSilent('time query daytime'))
		if (isFinite(day) && isFinite(tod)) return day * 24000 + tod
	} catch (e) { /* ниже */ }
	if (!HORDE_clockWarned) {
		HORDE_clockWarned = true
		hordeErr("не удалось узнать время суток ни getDayTime(), ни командой /time query - ночные орды пропускаются")
	}
	return null
}

ServerEvents.tick(event => {
	if (!HORDE_SERVER) HORDE_SERVER = event.server
	if (event.server.tickCount % HORDE_CHECK_INTERVAL !== 0) return

	event.server.players.forEach(player => {
		try {
			var dayTime = hordeDayTime(event.server, player.level)
			if (dayTime === null) return
			var timeOfDay = dayTime % 24000
			if (timeOfDay < HORDE_NIGHT_FROM) return // день

			var dayNumber = Math.floor(dayTime / 24000)
			var pd = player.persistentData
			// Number(...) обязателен: getLong отдаёт java.lang.Long, и строгое
			// сравнение с JS-числом всегда false - кубик бросался бы каждые 10
			// секунд всю ночь напролёт
			var lastNight = pd.contains('tfg_horde_last_night') ? Number(pd.getLong('tfg_horde_last_night')) : -1
			if (lastNight === dayNumber) return // за эту ночь уже бросали кубик

			pd.putLong('tfg_horde_last_night', dayNumber)
			var today = hordeToday()
			if (today < hordeNextDay(player, today)) return
			// не вышло заспавнить - попробуем следующей ночью, срок не сдвигаем
			if (!spawnHorde(player)) return
			pd.putLong('tfg_horde_next_day', today + hordeInterval())
			hordeLog(player.username + ": следующая орда - не раньше дня " + Number(pd.getLong('tfg_horde_next_day')))
		} catch (e) {
			hordeErr("ночная проверка для " + player.username, e)
		}
	})
})

// ─── Ручной вызов: /tfghorde ───────────────────────────────────────────────────

ServerEvents.commandRegistry(event => {
	var Commands = event.commands
	event.register(
		Commands.literal('tfghorde')
			.requires(src => src.hasPermission(2))
			.executes(ctx => {
				try {
					var player = ctx.source.getPlayerOrException()
					if (!HORDE_SERVER) HORDE_SERVER = ctx.source.getServer()
					var ok = spawnHorde(player)
					ctx.source.sendSuccess(Text.of(ok ? "Орда вызвана." : "Не удалось заспавнить орду - см. лог."), false)
				} catch (e) {
					hordeErr("/tfghorde", e)
					ctx.source.sendFailure(Text.of("Ошибка /tfghorde: " + String(e).substring(0, 300)))
				}
				return 1
			})
			// /tfghorde info - когда у игрока следующая орда
			.then(Commands.literal('info').executes(ctx => {
				try {
					var player = ctx.source.getPlayerOrException()
					var today = hordeToday()
					ctx.source.sendSuccess(Text.of("Орда: сегодня день " + today + ", следующая не раньше дня " +
						hordeNextDay(player, today) + ", ночью (в месяце " + Number(HORDE_Calendars.SERVER.getCalendarDaysInMonth()) + " дн.)"), false)
				} catch (e) {
					ctx.source.sendFailure(Text.of("Ошибка /tfghorde info: " + String(e).substring(0, 300)))
				}
				return 1
			}))
	)
	hordeLog("/tfghorde зарегистрирован")
})
