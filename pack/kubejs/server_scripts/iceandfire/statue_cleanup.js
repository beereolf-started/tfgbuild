// priority: 0
"use strict";

/**
 * СТАТУИ ГОРГОНЫ ИСЧЕЗАЮТ ЧЕРЕЗ 10 МИНУТ.
 *
 * Окаменевшие мобы (iceandfire:stone_statue) копятся в труднодоступных местах и грузят мир.
 * Статуя получает метку времени при первом появлении (в persistentData, переживает перезапуск),
 * и через STATUE_TTL тиков игрового времени исчезает. Статуи на базах игроков (в радиусе их
 * поселения, factions/settlements.js) не трогаем: там их могли поставить как украшение.
 * Расколдовать статую до исчезновения по-прежнему можно (iceandfire/unstone.js).
 */
const STATUE_TTL = 12000             // десять минут
var STATUES = {}                     // uuid -> сущность, пока загружена

function statueAtBase(e) {
	try {
		var r = global.TFG_SETTLEMENTS.radius
		var dim = String(e.level.getDimension())
		return global.TFG_SETTLEMENTS.all().some(pf => {
			if (!pf.base || pf.base.dim !== dim) return false
			var dx = e.getX() - pf.base.x, dz = e.getZ() - pf.base.z
			return dx * dx + dz * dz < r * r
		})
	} catch (err) { return false }
}

EntityEvents.spawned(event => {
	var e = event.entity
	try {
		if (!e || String(e.type) !== "iceandfire:stone_statue") return
		var pd = e.persistentData
		if (!pd.contains("tfg_statue_at")) pd.putLong("tfg_statue_at", Number(e.level.getTime()))
		STATUES[String(e.uuid)] = e
	} catch (err) { }
})

ServerEvents.tick(event => {
	if (event.server.tickCount % 200 !== 0) return
	for (var u in STATUES) {
		var e = STATUES[u]
		try {
			if (!e.isAlive() || e.isRemoved()) { delete STATUES[u]; continue }
			var age = Number(e.level.getTime()) - Number(e.persistentData.getLong("tfg_statue_at"))
			if (age < STATUE_TTL) continue
			delete STATUES[u]
			if (statueAtBase(e)) continue
			e.discard()
		} catch (err) {
			delete STATUES[u]
		}
	}
})
