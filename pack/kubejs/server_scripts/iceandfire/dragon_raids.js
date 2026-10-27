// priority: 0
"use strict";

/**
 * РЕЙД ДРАКОНОВ - редкое общее событие.
 *
 * Событие ОТДЕЛЬНОЕ для каждого игрока: примерно раз в полгода календаря TFC. Срок
 * следующего рейда - случайно через DR_MONTHS_MIN..DR_MONTHS_MAX месяцев после прошлого -
 * хранится в данных игрока. Драконы опасных зон (danger_spawns.js) живут по своим правилам.
 * При выпадении к этому игроку в обычном мире летит взрослый дракон. Вид - по зоне под
 * игроком (resolveCategory из danger_spawns.js): лёд - холод и арктика, огонь -
 * вулканы и пустыни, молния - шторм, болота, океан, джунгли; иначе огонь или молния.
 *
 * Дракон появляется в 60-90 блоках. Сам ИИ Ice and Fire игрока может и не заметить,
 * поэтому раз в 2 секунды ему заново выдаётся цель, пока игрок онлайн и ближе 160
 * блоков. Руны-обереги действуют: у дракона тег tfg_managed.
 *
 * Расстановка и взрослый возраст - iafFindSpot/iafSummonAt из danger_spawns.js.
 * Проверка вручную: /tfgdragonraid (оператор) - дракон тому, кто ввёл команду.
 */

const DR_MONTHS_MIN = 5                 // рейд дракона - раз в 5-7 месяцев календаря TFC, в среднем раз в полгода
const DR_MONTHS_MAX = 7
const DR_CHECK_INTERVAL = 200           // раз в 10 с смотрим, не наступил ли новый день
const DR_RETARGET_INTERVAL = 40
const DR_TARGET_RANGE = 160
const DR_FORGET_AFTER = 48000            // двое суток без игрока - перестаём вести дракона
const DR_Calendars = Java.loadClass("net.dries007.tfc.util.calendar.Calendars")
const DR_DRAGONS = { "iceandfire:fire_dragon": true, "iceandfire:ice_dragon": true, "iceandfire:lightning_dragon": true }

var DR_ACTIVE = {}           // uuid дракона -> { name, since }
var DR_pendingTarget = null  // имя игрока, пока выполняется наш summon

function drLog(msg) { global.tfgLog("tfg dragon_raid", msg) }
function drErr(msg, e) { global.tfgLogError("tfg dragon_raid", msg, e) }

function drInterval() {
	var month = Math.max(1, Number(DR_Calendars.SERVER.getCalendarDaysInMonth()))
	return Math.round(month * (DR_MONTHS_MIN + Math.random() * (DR_MONTHS_MAX - DR_MONTHS_MIN)))
}

/** День, раньше которого рейда дракона у игрока не будет; впервые - от прошлого рейда, если был, иначе от сегодня. */
function drNextDay(player, today) {
	var pd = player.persistentData
	if (!pd.contains("tfg_dragon_raid_next_day")) {
		var from = pd.contains("tfg_dragon_raid_last_day") ? Number(pd.getLong("tfg_dragon_raid_last_day")) : today
		pd.putLong("tfg_dragon_raid_next_day", from + drInterval())
		drLog(player.username + ": следующий рейд дракона - не раньше дня " + Number(pd.getLong("tfg_dragon_raid_next_day")))
	}
	return Number(pd.getLong("tfg_dragon_raid_next_day"))
}

function drPlayerByName(server, name) {
	var found = null
	server.players.forEach(p => { if (String(p.username) === name) found = p })
	return found
}

function drDragonFor(level, pos) {
	var key = ""
	try {
		var rc = resolveCategory(level, pos)
		if (rc) key = rc.key
	} catch (e) { }
	if (key === "cold" || key === "arctic") return "iceandfire:ice_dragon"
	if (key === "volcanic" || key === "desert") return "iceandfire:fire_dragon"
	if (key === "storm" || key === "wetland" || key === "ocean" || key === "jungle") return "iceandfire:lightning_dragon"
	return Math.random() < 0.5 ? "iceandfire:fire_dragon" : "iceandfire:lightning_dragon"
}

function drAnnounce(server, name) {
	server.runCommandSilent('title ' + name + ' times 10 80 20')
	server.runCommandSilent('title ' + name + ' subtitle {"text":"Небо дрожит от рёва","color":"gold"}')
	server.runCommandSilent('title ' + name + ' title {"text":"ДРАКОН","color":"dark_red","bold":true}')
	server.runCommandSilent('tellraw ' + name + ' [{"text":"[Рейд] ","color":"dark_red","bold":true},{"text":"Дракон учуял вас и летит сюда.","color":"red"}]')
}

function drSpawnFor(server, player) {
	var level = player.level
	// getDimension() явно: у уровня есть и метод игры dimension(), .dimension отдал бы его
	if (String(level.getDimension()) !== "minecraft:overworld") return false
	var name = String(player.username)
	var dragon = drDragonFor(level, player.blockPosition)
	var spot = iafFindSpot(level, player.blockX, player.blockZ, dragon, 60, 30, true)
	if (!spot) {
		drLog(name + ": не нашлось места для дракона")
		return false
	}
	var ok = false
	DR_pendingTarget = name
	try {
		ok = iafSummonAt(server, name, dragon, spot, ["tfg_managed", "tfg_dragon_raid"])
	} finally {
		DR_pendingTarget = null
	}
	if (ok) drAnnounce(server, name)
	drLog(name + ": " + dragon + (ok ? " вызван" : " НЕ появился") + " в " + spot.x + " " + spot.y + " " + spot.z)
	return ok
}

// Дракон из нашего summon регистрируется прямо внутри команды: событие появления
// срабатывает синхронно, пока DR_pendingTarget ещё выставлен.
EntityEvents.spawned(event => {
	if (!DR_pendingTarget) return
	try {
		var ent = event.entity
		if (!DR_DRAGONS[String(ent.type)]) return
		DR_ACTIVE[String(ent.uuid)] = { name: DR_pendingTarget, since: ent.getServer().tickCount, uuid: ent.uuid }
	} catch (e) {
		drErr("регистрация дракона", e)
	}
})

ServerEvents.tick(event => {
	var server = event.server
	var tick = server.tickCount

	if (tick % DR_CHECK_INTERVAL === 0) {
		var today = null
		try {
			today = Number(DR_Calendars.SERVER.getTotalCalendarDays())
		} catch (e) {
			drErr("календарь TFC", e)
		}
		if (today !== null && isFinite(today)) {
			// у каждого игрока свой срок - события не синхронизированы
			server.players.forEach(player => {
				try {
					var pd = player.persistentData
					var lastCheck = pd.contains("tfg_dragon_raid_last_check") ? Number(pd.getLong("tfg_dragon_raid_last_check")) : -1
					if (today === lastCheck) return
					pd.putLong("tfg_dragon_raid_last_check", today)
					if (today < drNextDay(player, today)) return
					drLog(player.username + ": срок рейда дракона (день " + today + ")")
					// не вышло (не обычный мир, нет места) - попробуем завтра, срок не сдвигаем
					if (!drSpawnFor(server, player)) return
					pd.putLong("tfg_dragon_raid_last_day", today)
					pd.putLong("tfg_dragon_raid_next_day", today + drInterval())
					drLog(player.username + ": следующий рейд дракона - не раньше дня " + Number(pd.getLong("tfg_dragon_raid_next_day")))
				} catch (e) {
					drErr("суточная проверка для " + player.username, e)
				}
			})
		}
	}

	if (tick % DR_RETARGET_INTERVAL === 0) {
		for (var uuid in DR_ACTIVE) {
			try {
				var rec = DR_ACTIVE[uuid]
				var player = drPlayerByName(server, rec.name)
				if (!player) {
					if (tick - rec.since > DR_FORGET_AFTER) delete DR_ACTIVE[uuid]
					continue
				}
				// getEntity - с объектом UUID, как в raids.js (members хранят raidEntity.uuid)
				var dragon = player.level.getEntity(rec.uuid)
				if (!dragon || !dragon.isAlive()) {
					delete DR_ACTIVE[uuid]
					continue
				}
				rec.since = tick
				if (player.isCreative() || player.isSpectator()) continue
				var dx = dragon.getX() - player.getX()
				var dz = dragon.getZ() - player.getZ()
				if (dx * dx + dz * dz > DR_TARGET_RANGE * DR_TARGET_RANGE) continue
				dragon.setTarget(player)
			} catch (e) {
				drErr("ведение дракона " + uuid, e)
				delete DR_ACTIVE[uuid]
			}
		}
	}
})

ServerEvents.commandRegistry(event => {
	var Commands = event.commands
	event.register(
		Commands.literal("tfgdragonraid")
			.requires(src => src.hasPermission(2))
			.executes(ctx => {
				try {
					var ok = drSpawnFor(ctx.source.getServer(), ctx.source.getPlayerOrException())
					ctx.source.sendSuccess(Text.of(ok ? "Дракон вызван." : "Дракон не появился - подробности в логе."), false)
				} catch (e) {
					drErr("/tfgdragonraid", e)
					ctx.source.sendFailure(Text.of("Ошибка /tfgdragonraid: " + String(e).substring(0, 300)))
				}
				return 1
			})
			// /tfgdragonraid info - когда у игрока следующий рейд дракона
			.then(Commands.literal("info").executes(ctx => {
				try {
					var player = ctx.source.getPlayerOrException()
					var today = Number(DR_Calendars.SERVER.getTotalCalendarDays())
					ctx.source.sendSuccess(Text.of("Рейд дракона: сегодня день " + today + ", следующий не раньше дня " +
						drNextDay(player, today) + " (в месяце " + Number(DR_Calendars.SERVER.getCalendarDaysInMonth()) + " дн.)"), false)
				} catch (e) {
					ctx.source.sendFailure(Text.of("Ошибка /tfgdragonraid info: " + String(e).substring(0, 300)))
				}
				return 1
			}))
	)
})
