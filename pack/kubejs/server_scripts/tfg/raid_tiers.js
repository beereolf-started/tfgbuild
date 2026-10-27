// priority: 10
"use strict";

/**
 * ТИР ИГРОКА И СЛОЖНОСТЬ РЕЙДОВ.
 *
 * Тир - счётчик прогресса: самый высокий материал, чьи готовые доспехи, оружие или инструменты
 * (а также машины и детали GregTech по вольтажу и стволы TACZ по рецептам сборки) побывали у игрока
 * в инвентаре в режиме выживания. Счётчик только растёт и хранится в данных игрока.
 *   1 медь | 2 бронзы | 3 кованое железо | 4 сталь, LV | 5 чёрная сталь | 6 синяя и красная сталь
 *   7 алюминий, MV | 8 нержавейка, HV | 9 титан, EV | 10 вольфрамовая сталь, IV и выше
 * Что было у игрока до установки скрипта, узнать нельзя: старт - текущий инвентарь, дальше -
 * /tfgraid tier set.
 *
 * Сложность рейда 0.5..2 = 1 + 0.1 за каждый игровой день без смерти (не больше +0.5)
 *   + поправка по итогам рейдов (tfg/raids.js): отбит быстро и без смертей +0.25, долгий или со
 *   смертью игрока -0.25.
 *
 * Отдаёт наружу: global.TFG_PLAYER_TIER, TFG_ITEM_TIER, TFG_ITEM_ID_TIER, TFG_GUN_TIER,
 * TFG_RAID_DIFFICULTY, TFG_RAID_ADJUST.
 */

const TIER_Calendars = Java.loadClass("net.dries007.tfc.util.calendar.Calendars")
const TIER_SCAN_INTERVAL = 200   // раз в 10 секунд
const TIER_MAX = 10

// материал -> тир; длинные имена раньше коротких, иначе black_steel засчитается как steel
const TIER_MATERIALS = [
	["tungsten_steel", 10], ["tungstensteel", 10], ["hsla_steel", 9], ["titanium", 9], ["stainless_steel", 8],
	["aluminium", 7], ["aluminum", 7], ["blue_steel", 6], ["red_steel", 6], ["black_steel", 5], ["steel", 4],
	["wrought_iron", 3], ["bismuth_bronze", 2], ["black_bronze", 2], ["arsenic_bronze", 2], ["bronze", 2], ["copper", 1],
]
// готовое снаряжение; головки, формы и незаконченное не считаются
const TIER_GEAR = ["helmet", "chestplate", "greaves", "leggings", "boots", "sword", "mace", "javelin", "axe", "pickaxe",
	"shovel", "hoe", "hammer", "knife", "saw", "scythe", "chisel", "propick", "shears", "shield", "spade", "wrench", "file",
	"crowbar", "screwdriver", "wire_cutter", "mallet", "mortar", "drill", "chainsaw", "buzzsaw", "plunger"]
const TIER_NOT_GEAR = ["head", "unfinished", "mold", "blade", "extruder", "casting"]
// машины и детали GregTech: gtceu:<вольтаж>_...
const TIER_VOLTAGE = { ulv: 4, lv: 4, mv: 7, hv: 8, ev: 9, iv: 10, luv: 10, zpm: 10, uv: 10, uhv: 10 }
// стволы TACZ - по рецептам сборки (tacz/recipes.guns.js): материалы и вольтаж сборщика
const TIER_GUNS = {
	"ulv_guns:flintlock": 3,                          // латунь, трубка из оловянного сплава
	"tacz:springfield1873": 5,                        // чёрная сталь
	"create_armorer:pistol_revolver_torque": 5,       // чёрная сталь, сборщик LV
	"tacz:db_short": 7, "tacz:db_long": 7,            // сборщик MV
	"create_armorer:pistol_auto_stress": 7, "create_armorer:rifle_assult_crane": 7,
	"create_armorer:smg_auto_crank": 7, "create_armorer:shotgun_pump_bearing": 7,
	"create_armorer:sniper_semi_clockwork": 7, "create_armorer:mg_platemag_flywheel": 7, "tacz:m700": 7,
	"applied_armorer:niklas_pistol_semi_right": 9, "applied_armorer:niklas_pistol_semi_pride": 9,
	"applied_armorer:niklas_pistol_double_win_win": 9, "applied_armorer:moritz_sniper_semi_k30": 9,
	"applied_armorer:moritz_rifle_ar77": 9, "applied_armorer:moritz_shotgun_sg914": 9,
	"applied_armorer:niklas_smg_freedom": 9,          // титан, нержавейка, сборщик EV
	"applied_armorer:moritz_gernade_gl3": 10,         // вольфрамовая сталь
	"create_armorer:cannon_40mm_salamander": 10,
}

function tierTokens(s) { return "/" + String(s).replace(/[_:]/g, "/") + "/" }

/** Тир предмета по id (без NBT): вольтаж GregTech или материал готового снаряжения; 0 - не снаряжение. */
function tierOfId(id) {
	id = String(id)
	var colon = id.indexOf(":")
	var ns = colon >= 0 ? id.substring(0, colon) : "minecraft"
	var path = colon >= 0 ? id.substring(colon + 1) : id
	if (ns === "gtceu") {
		var us = path.indexOf("_")
		if (us > 0 && TIER_VOLTAGE[path.substring(0, us)]) return TIER_VOLTAGE[path.substring(0, us)]
	}
	var tokens = tierTokens(path)
	var gear = false
	for (var g = 0; g < TIER_GEAR.length && !gear; g++) gear = tokens.indexOf(tierTokens(TIER_GEAR[g])) >= 0
	if (!gear) return 0
	for (var n = 0; n < TIER_NOT_GEAR.length; n++) if (tokens.indexOf("/" + TIER_NOT_GEAR[n] + "/") >= 0) return 0
	for (var m = 0; m < TIER_MATERIALS.length; m++) {
		if (tokens.indexOf(tierTokens(TIER_MATERIALS[m][0])) >= 0) return TIER_MATERIALS[m][1]
	}
	return 0
}

/** Тир стака: ствол TACZ - по GunId, остальное - по id. */
function tierOfStack(stack) {
	if (!stack || stack.isEmpty()) return 0
	var id = String(stack.id)
	if (id === "tacz:modern_kinetic_gun") {
		try {
			var nbt = stack.getNbt()
			return nbt ? (TIER_GUNS[String(nbt.getString("GunId"))] || 0) : 0
		} catch (e) {
			return 0
		}
	}
	return tierOfId(id)
}

function tierToday() { return Number(TIER_Calendars.SERVER.getTotalCalendarDays()) }

function tierOfPlayer(player) {
	var t = Number(player.persistentData.getInt("tfg_tier"))
	return t >= 1 ? Math.min(TIER_MAX, t) : 1
}

function tierDifficultyParts(player) {
	var pd = player.persistentData
	var start = pd.contains("tfg_life_start_day") ? Number(pd.getLong("tfg_life_start_day")) : tierToday()
	var days = Math.max(0, tierToday() - start)
	var adj = pd.contains("tfg_raid_adj") ? Number(pd.getDouble("tfg_raid_adj")) : 0
	var value = Math.max(0.5, Math.min(2, 1 + Math.min(0.5, days * 0.1) + adj))
	return { days: days, adj: adj, value: value }
}

global.TFG_ITEM_ID_TIER = tierOfId
global.TFG_ITEM_TIER = tierOfStack
global.TFG_GUN_TIER = TIER_GUNS
global.TFG_PLAYER_TIER = tierOfPlayer
global.TFG_RAID_DIFFICULTY = player => tierDifficultyParts(player).value
global.TFG_RAID_ADJUST = (player, delta) => {
	var pd = player.persistentData
	var adj = pd.contains("tfg_raid_adj") ? Number(pd.getDouble("tfg_raid_adj")) : 0
	pd.putDouble("tfg_raid_adj", Math.max(-1, Math.min(1, adj + delta)))
}

// раз в 10 секунд: максимум тиров в инвентаре игроков в выживании (броня и вторая рука - тоже там)
ServerEvents.tick(event => {
	if (event.server.tickCount % TIER_SCAN_INTERVAL !== 0) return
	event.server.players.forEach(player => {
		try {
			if (player.isCreative() || player.isSpectator()) return
			var pd = player.persistentData
			if (!pd.contains("tfg_life_start_day")) pd.putLong("tfg_life_start_day", tierToday())
			var inv = player.getInventory()
			var best = 0
			var bestId = ""
			for (var i = 0; i < inv.getContainerSize(); i++) {
				var stack = inv.getItem(i)
				var t = tierOfStack(stack)
				if (t > best) {
					best = t
					bestId = String(stack.id)
				}
			}
			var cur = Number(pd.getInt("tfg_tier"))
			if (best > cur) {
				pd.putInt("tfg_tier", best)
				global.tfgLog("tfg tier", player.username + ": тир " + cur + " -> " + best + " (" + bestId + ")")
			}
		} catch (e) {
			global.tfgLogError("tfg tier", "проверка инвентаря " + player.username, e)
		}
	})
})

// смерть игрока обнуляет стаж жизни; идущий рейд засчитается тяжёлым (tfg/raids.js)
EntityEvents.death(event => {
	var e = event.entity
	if (!e.isPlayer()) return
	try {
		e.persistentData.putLong("tfg_life_start_day", tierToday())
		if (typeof global.TFG_RAID_PLAYER_DIED === "function") global.TFG_RAID_PLAYER_DIED(e)
	} catch (err) {
		global.tfgLogError("tfg tier", "смерть игрока", err)
	}
})

// ---- команды: /tfgraid tier ..., /tfgraid difficulty ... (узел tfgraid общий с tfg/raids.js) ----

ServerEvents.commandRegistry(event => {
	var Commands = event.commands
	var Arguments = event.arguments
	var say = (ctx, msg) => ctx.source.sendSuccess(Text.of(msg), false)
	var guard = (ctx, fn) => {
		try {
			fn()
		} catch (e) {
			ctx.source.sendFailure(Text.of("Ошибка: " + String(e).substring(0, 300)))
		}
		return 1
	}
	var info = p => {
		var d = tierDifficultyParts(p)
		return p.username + ": тир " + tierOfPlayer(p) + ", сложность " + d.value.toFixed(2) +
			" (дней без смерти " + d.days + ", поправка по рейдам " + (d.adj >= 0 ? "+" : "") + d.adj.toFixed(2) + ")"
	}
	var reset = p => {
		p.persistentData.putDouble("tfg_raid_adj", 0)
		p.persistentData.putLong("tfg_life_start_day", tierToday())
		return "сложность сброшена. " + info(p)
	}
	var self = ctx => ctx.source.getPlayerOrException()
	var arg = ctx => Arguments.PLAYER.getResult(ctx, "player")

	event.register(Commands.literal("tfgraid").requires(src => src.hasPermission(2))
		.then(Commands.literal("tier")
			.then(Commands.literal("info")
				.executes(ctx => guard(ctx, () => say(ctx, info(self(ctx)))))
				.then(Commands.argument("player", Arguments.PLAYER.create(event))
					.executes(ctx => guard(ctx, () => say(ctx, info(arg(ctx)))))))
			.then(Commands.literal("set")
				.then(Commands.argument("player", Arguments.PLAYER.create(event))
					.then(Commands.argument("tier", Arguments.INTEGER.create(event))
						.executes(ctx => guard(ctx, () => {
							var p = arg(ctx)
							var t = Math.max(1, Math.min(TIER_MAX, Arguments.INTEGER.getResult(ctx, "tier")))
							p.persistentData.putInt("tfg_tier", t)
							say(ctx, "тир выставлен. " + info(p))
						}))))))
		.then(Commands.literal("difficulty")
			.then(Commands.literal("info")
				.executes(ctx => guard(ctx, () => say(ctx, info(self(ctx)))))
				.then(Commands.argument("player", Arguments.PLAYER.create(event))
					.executes(ctx => guard(ctx, () => say(ctx, info(arg(ctx)))))))
			.then(Commands.literal("reset")
				.executes(ctx => guard(ctx, () => say(ctx, reset(self(ctx)))))
				.then(Commands.argument("player", Arguments.PLAYER.create(event))
					.executes(ctx => guard(ctx, () => say(ctx, reset(arg(ctx)))))))))
})
