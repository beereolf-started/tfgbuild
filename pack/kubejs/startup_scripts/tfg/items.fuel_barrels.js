// priority: 0
"use strict";

/**
 * Топливо для авиадвигателей (Immersive Aircraft).
 *
 * ДВЕ СТАДИИ:
 *  1. tfg:fuel_tank - ПУСТОЙ/ЧАСТИЧНО ЗАПОЛНЕННЫЙ бак. Это предмет типа
 *     tfc:fluid_container от kubejs_tfc - под капотом настоящий
 *     net.dries007.tfc.common.items.FluidContainerItem, тот же класс, что у
 *     кувшинов и вёдер TFC. Значит бесплатно и по-настоящему работают:
 *       - жидкостная капабилити Forge (заливка из бочек, кранов, чего угодно
 *         штатными средствами, без единой строки своего кода);
 *       - тултип с содержимым и уровнем;
 *       - визуальное наполнение в модели (loader "tfc:contained_fluid":
 *         слой base - сам бак, слой fluid - окошко, красится в цвет жидкости);
 *       - состояние в NBT предмета, поэтому оно переживает всё - поломку,
 *         сундуки, смерть. (Раньше бак был БЛОКОМ, состояние хранилось в NBT
 *         блока, и из-за неработающего KubeJS-метода mergeEntityData не
 *         сохранялось вообще - залитое топливо просто исчезало.)
 *
 *  2. tfg:fuel_barrel_<вещество> - ПОЛНЫЙ бак, отдельный предмет. Именно его
 *     ест самолёт. Полный tfg:fuel_tank превращается в него по ПКМ, см.
 *     server_scripts/immersive_aircraft/events.fuel_tank.js.
 *
 * ПОЧЕМУ ДВЕ СТАДИИ, А НЕ ОДИН ЖИДКОСТНЫЙ ПРЕДМЕТ: самолёт опознаёт топливо по
 * ИМЕНИ ПРЕДМЕТА - проверено байткодом Utils.getFuelTime(ItemStack):
 *     сначала Config.fuelList (config/immersive_aircraft.json) по id предмета,
 *     и только если там нет и включён acceptVanillaFuel - время горения в печи.
 * В этом паке fuelList уже заполнен на все 12 tfg:fuel_barrel_*, а
 * acceptVanillaFuel = false. Значит отдача топлива задаётся ТАМ, и один
 * предмет-бак с разными жидкостями в NBT самолёт различить бы не смог: id у
 * него один. Отсюда и вторая стадия - отдельный предмет на каждое вещество.
 *
 * ЗНАЧЕНИЯ ОТДАЧИ ПРАВЯТСЯ НЕ ЗДЕСЬ, а в config/immersive_aircraft.json ->
 * fuelList. Специально НЕ ставим burnTime у бочек: он самолёту не нужен
 * (acceptVanillaFuel = false), зато сделал бы бочки топливом для печей и горнов.
 *
 * Расходуется целиком, но не пропадает бесследно: containerItem(...) (самолёт
 * явно зовёт Item.getCraftingRemainingItem(), тот же механизм, что у ведра лавы
 * в печке) возвращает пустой tfg:fuel_tank, можно заливать заново.
 *
 * Текстуры - программно сгенерированные цветные плейсхолдеры, не арт.
 */

/**
 * Список должен совпадать с ключами fuelList в config/immersive_aircraft.json
 * (там же и отдача каждого топлива) и с тегом #tfg:aircraft_fuel в
 * server_scripts/immersive_aircraft/tags.js.
 */
const TFG_FUEL_BARREL_TYPES = [
	'diesel', 'cetane_boosted_diesel', 'gasoline', 'high_octane_gasoline',
	'ethanol', 'methanol', 'bio_diesel', 'creosote',
	'seed_oil', 'tallow', 'olive_oil', 'bioethanol'
]

/**
 * Файл сам вешает свой StartupEvents.registry - подключать его в
 * startup_scripts/tfg/items.js не нужно, механика самодостаточна.
 */
StartupEvents.registry('item', event => {

	/**
	 * Пустой/недолитый бак. Ёмкость общая с TANK_CAPACITY в events.fuel_tank.js.
	 * Принимаемые жидкости ограничены тегом #tfg:aircraft_fuel (см.
	 * server_scripts/immersive_aircraft/tags.js) - иначе в бак можно было бы
	 * налить воду или расплавленный металл.
	 *
	 * canPlaceLiquid/canPlaceLiquidSource выключены: бак - не ведро, разливать
	 * дизель по местности из него не нужно.
	 */
	event.create('tfg:fuel_tank', 'tfc:fluid_container')
		.capacity(50000)
		.fluidTagAccept('tfg:aircraft_fuel')
		.canPlaceLiquid(false)
		.canPlaceLiquidSource(false)
		.texture('base', 'tfg:item/empty_fuel_barrel')
		.texture('fluid', 'tfg:item/fuel_tank_overlay')

	// Полные баки - то, что реально ест самолёт
	TFG_FUEL_BARREL_TYPES.forEach(name => {
		event.create(`tfg:fuel_barrel_${name}`)
			.texture(`tfg:item/fuel_barrel_${name}`)
			.containerItem('tfg:fuel_tank')
	})
})
