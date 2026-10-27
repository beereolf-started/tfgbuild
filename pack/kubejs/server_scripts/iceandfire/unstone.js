// priority: 0
"use strict";

/**
 * РАСКОЛДОВАТЬ ОКАМЕНЕВШИХ МОБОВ.
 *
 * Механика для игроков: правой кнопкой по статуе горгоны (iceandfire:stone_statue) с лечебным
 * снадобьем TFG из UNSTONE_CURES - моб оживает, снадобье тратится. Для оператора есть ещё команда
 * /tfgunstone [радиус] - всех статуй вокруг разом.
 *
 * Статуя хранит тип моба в StatueEntityType и его данные в StatueEntityTag
 * (EntityStoneStatue.addAdditionalSaveData, байткод IaF 2.1.13). По ним моб создаётся заново на месте
 * статуи - со своим возрастом, полом и приручением TFC. Здоровье, UUID и таймер смерти не переносятся:
 * статуя записана в момент гибели от взгляда горгоны. Окаменевших игроков не трогаем.
 */
const UNSTONE_AABB = Java.loadClass("net.minecraft.world.phys.AABB")
const UNSTONE_CURES = {
	"tfg:instant_health_salvo": true,   // мазь мгновенного исцеления
	"tfg:regeneration_tablet": true,    // таблетка регенерации
}

/** Оживить моба из статуи; вернуть его тип или null. */
function unstoneOne(statue) {
	var level = statue.level
	var server = statue.getServer()
	var nbt = statue.nbt
	var type = String(nbt.getString("StatueEntityType"))
	if (!type || type === "minecraft:player") return null
	var tag = nbt.getCompound("StatueEntityTag")
	tag.remove("UUID")
	tag.remove("Health")
	tag.remove("DeathTime")
	tag.remove("HurtTime")
	var x = statue.getX()
	var y = statue.getY()
	var z = statue.getZ()
	var at = "execute in " + String(level.getDimension()) + " run "
	if (!(Number(server.runCommandSilent(at + "summon " + type + " " + x + " " + y + " " + z + " " + tag)) > 0)) return null
	statue.discard()
	server.runCommandSilent(at + "particle minecraft:happy_villager " + x + " " + (y + 0.8) + " " + z + " 0.5 0.6 0.5 0 25")
	server.runCommandSilent(at + "playsound minecraft:block.amethyst_block.chime neutral @a " + x + " " + y + " " + z + " 1 1")
	return type
}

ItemEvents.entityInteracted(event => {
	var target = event.target
	if (!target || String(target.type) !== "iceandfire:stone_statue") return
	var item = event.item
	if (!item || item.isEmpty() || !UNSTONE_CURES[String(item.id)]) return
	var done = null
	try {
		done = unstoneOne(target)
		if (done && !event.player.isCreative()) item.shrink(1)
	} catch (e) {
		global.tfgLogError("tfg unstone", "статуя " + target, e)
	}
	// вне try: cancel() в KubeJS прерывает обработчик исключением-выходом
	if (done) event.cancel()
})

function unstoneAround(player, radius) {
	var box = new UNSTONE_AABB(player.getX() - radius, player.getY() - radius, player.getZ() - radius,
		player.getX() + radius, player.getY() + radius, player.getZ() + radius)
	var list = player.level.getEntities(player, box)
	var restored = {}
	var failed = 0
	for (var i = 0; i < list.size(); i++) {
		var e = list.get(i)
		if (String(e.type) !== "iceandfire:stone_statue") continue
		var type = unstoneOne(e)
		if (type) restored[type] = (restored[type] || 0) + 1
		else failed++
	}
	var parts = Object.keys(restored).map(k => k + " x" + restored[k])
	return (parts.length ? "Расколдовано: " + parts.join(", ") : "Статуй рядом нет") + (failed ? ". Не вышло: " + failed : "")
}

ServerEvents.commandRegistry(event => {
	var Commands = event.commands
	var Arguments = event.arguments
	var run = (ctx, radius) => {
		try {
			ctx.source.sendSuccess(Text.of(unstoneAround(ctx.source.getPlayerOrException(), radius)), false)
		} catch (e) {
			ctx.source.sendFailure(Text.of("Ошибка /tfgunstone: " + String(e).substring(0, 300)))
		}
		return 1
	}
	event.register(Commands.literal("tfgunstone")
		.requires(src => src.hasPermission(2))
		.executes(ctx => run(ctx, 16))
		.then(Commands.argument("radius", Arguments.INTEGER.create(event))
			.executes(ctx => run(ctx, Math.max(1, Math.min(64, Arguments.INTEGER.getResult(ctx, "radius")))))))
})
