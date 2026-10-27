// priority: 0
"use strict";

/**
 * Превращение полного заправочного бака в готовое топливо для самолёта.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ЧТО ЗДЕСЬ БОЛЬШЕ НЕ НУЖНО ДЕЛАТЬ РУКАМИ
 *
 * Раньше в этом файле жил ручной перелив: своя жидкостная капабилити, свой
 * drain/fill через рефлексию, своё хранение состояния в NBT блока. Всё это
 * убрано - tfg:fuel_tank теперь предмет типа tfc:fluid_container (наследник
 * net.dries007.tfc.common.items.FluidContainerItem, см. startup_scripts/tfg/
 * items.fuel_barrels.js). Заливкой, сливом, тултипом с уровнем, отрисовкой
 * наполнения и хранением состояния занимается TFC штатными средствами.
 *
 * Осталась ровно одна вещь, которую сам TFC сделать не может: узнать, что бак
 * долит до конца, и подменить его на tfg:fuel_barrel_<вещество> - именно эти
 * предметы ест самолёт (он опознаёт топливо по времени горения в печи,
 * ForgeHooks.getBurnTime, а burnTime задаётся на предмет, не на NBT).
 *
 * ВАЖНО НА БУДУЩЕЕ, если сюда снова придётся звать Java: в этом паке ЛЮБАЯ
 * перегрузка Java-метода, у чьего параметра зарегистрирован TypeWrapper,
 * побеждает всегда, независимо от реального типа аргумента - Rhino даёт такому
 * варианту наилучший вес 0. Из-за этого drain(1000, EXECUTE) молча уходил в
 * drain(FluidStack, ...), а число превращалось в пустой FluidStack; ровно так же
 * Integer.valueOf(число) уходит в valueOf(String). Обход - java.lang.reflect с
 * явно выбранной перегрузкой. Здесь ничего этого не нужно: getFluidInTank(int)
 * не перегружен.
 * ─────────────────────────────────────────────────────────────────────────────
 */

const TankForgeCapabilities = Java.loadClass("net.minecraftforge.common.capabilities.ForgeCapabilities")
const TankForgeRegistries = Java.loadClass("net.minecraftforge.registries.ForgeRegistries")
const TankResourceLocationClass = Java.loadClass("net.minecraft.resources.ResourceLocation")
const TankSoundSourceClass = Java.loadClass("net.minecraft.sounds.SoundSource")

/** Должно совпадать с .capacity(...) у tfg:fuel_tank в items.fuel_barrels.js */
const TANK_CAPACITY = 50000

/**
 * Жидкость -> суффикс готового предмета tfg:fuel_barrel_<...>.
 * Список должен совпадать с тегом #tfg:aircraft_fuel (tags.js) - тег решает, что
 * ВООБЩЕ можно налить в бак, а эта таблица - во что превращать полный бак.
 */
const TANK_FUELS = {
	'gtceu:diesel': 'diesel',
	'gtceu:cetane_boosted_diesel': 'cetane_boosted_diesel',
	'gtceu:gasoline': 'gasoline',
	'gtceu:high_octane_gasoline': 'high_octane_gasoline',
	'gtceu:ethanol': 'ethanol',
	'gtceu:methanol': 'methanol',
	'gtceu:bio_diesel': 'bio_diesel',
	'gtceu:creosote': 'creosote',
	'gtceu:seed_oil': 'seed_oil',
	'tfc:tallow': 'tallow',
	'tfc:olive_oil': 'olive_oil',
	'createaddition:bioethanol': 'bioethanol',
}

var TANK_SOUND_FILL = null
try {
	TANK_SOUND_FILL = TankForgeRegistries.SOUND_EVENTS.getValue(new TankResourceLocationClass('minecraft', 'item.bucket.fill'))
} catch (e) {
	global.tfgLog('tfg fuel_tank', `звук не загрузился: ${e}`)
}

/**
 * Forge получает жидкостную капабилити предмета одноаргументным вызовом
 * (FluidUtil.getFluidHandler) - делаем так же.
 */
function tankFluidHandler(itemStack) {
	if (!itemStack || itemStack.isEmpty()) return null
	var opt = itemStack.getCapability(TankForgeCapabilities.FLUID_HANDLER_ITEM)
	if (!opt.isPresent()) return null
	return opt.resolve().get()
}

function tankFluidName(fluidObj) {
	if (!fluidObj) return null
	var key = TankForgeRegistries.FLUIDS.getKey(fluidObj)
	return key ? (TANK_FUELS[key.toString()] || null) : null
}

function tankStatus(player, message) {
	try {
		player.displayClientMessage(Text.of(message), true) // true = строка над хотбаром
	} catch (e) {
		global.tfgLog('tfg fuel_tank', `сообщение не отправилось: ${e}`)
	}
}

/**
 * ПКМ по воздуху баком в руке. Полный бак -> готовый tfg:fuel_barrel_<вещество>,
 * недолитый - просто показывает уровень (то же, что в тултипе, но не надо
 * наводиться).
 */
/**
 * АВТОМАТИЧЕСКОЕ ПРЕВРАЩЕНИЕ ПОЛНОГО БАКА В БОЧКУ.
 *
 * Раньше это делал только ПКМ по воздуху - и оказалось, что так механика просто
 * не работает: по логам обработчик не сработал НИ РАЗУ, потому что о жесте надо
 * знать. В итоге на руках всегда был заполненный tfg:fuel_tank, а его нет в
 * fuelList конфига, поэтому FuelSlot.mayPlace (= getFuelTime(stack) > 0) его
 * отвергал - бочка "не клалась в слот" ни в один аппарат.
 *
 * Теперь полный бак превращается в bочку сам, где бы он ни лежал в инвентаре.
 * ПКМ оставлен как запасной способ.
 */
const TANK_SCAN_INTERVAL = 20 // раз в секунду, 36 слотов - дёшево

ServerEvents.tick(event => {
	if (event.server.tickCount % TANK_SCAN_INTERVAL !== 0) return
	event.server.players.forEach(player => {
		try {
			var inv = player.getInventory()
			var size = inv.getContainerSize()
			for (var i = 0; i < size; i++) {
				var stack = inv.getItem(i)
				if (!stack || stack.isEmpty()) continue
				if (String(stack.getItem()) !== 'tfg:fuel_tank' && stack.id !== 'tfg:fuel_tank') continue

				var handler = tankFluidHandler(stack)
				if (!handler) continue
				var contained = handler.getFluidInTank(0)
				if (!contained || contained.getAmount() < TANK_CAPACITY) continue
				var name = tankFluidName(contained.getFluid())
				if (!name) continue

				inv.setItem(i, Item.of(`tfg:fuel_barrel_${name}`, stack.getCount()))
				tankStatus(player, `Бак укупорен: ${name}`)
				global.tfgLog('tfg fuel_tank', `${player.username}: полный бак в слоте ${i} -> tfg:fuel_barrel_${name}`)
			}
		} catch (e) {
			global.tfgLogError('tfg fuel_tank', `автопревращение у ${player.username}: ${e}`)
		}
	})
})

ItemEvents.rightClicked('tfg:fuel_tank', event => {
	var player = event.player
	var converted = false

	try {
		var handler = tankFluidHandler(event.item)
		if (handler) {
			var contained = handler.getFluidInTank(0)
			var amount = contained ? contained.getAmount() : 0
			var name = amount > 0 ? tankFluidName(contained.getFluid()) : null

			if (amount < TANK_CAPACITY) {
				tankStatus(player, amount <= 0
					? `Бак пуст (0 / ${TANK_CAPACITY} мБ)`
					: `${name || contained.getFluid()}: ${amount} / ${TANK_CAPACITY} мБ`)
			} else if (!name) {
				// в теге #tfg:aircraft_fuel есть жидкость, которой нет в TANK_FUELS
				global.tfgLogError("tfg fuel_tank", `полный бак с ${TankForgeRegistries.FLUIDS.getKey(contained.getFluid())} - этой жидкости нет в TANK_FUELS, превращать не во что`)
				tankStatus(player, `Для этой жидкости нет готового бака`)
			} else {
				player.setHeldItem(event.hand, Item.of(`tfg:fuel_barrel_${name}`))
				converted = true
				try {
					if (TANK_SOUND_FILL) player.playNotifySound(TANK_SOUND_FILL, TankSoundSourceClass.BLOCKS, 1.0, 1.0)
				} catch (e) {
					global.tfgLog('tfg fuel_tank', `звук не сыграл: ${e}`)
				}
				tankStatus(player, `Бак укупорен: ${name}`)
				global.tfgLog('tfg fuel_tank', `${player.username}: полный бак -> tfg:fuel_barrel_${name}`)
			}
		}
	} catch (e) {
		global.tfgLogError('tfg fuel_tank', `${player.username}: ${e}` + (e.stack ? ("\n" + e.stack) : ""))
	}

	// вне try: cancel() работает броском EventExit, свой же catch выше его бы съел.
	// Отменяем только после подмены предмета, чтобы штатный use() у TFC не отработал
	// по уже несуществующему баку. В остальных случаях не мешаем TFC.
	if (converted) event.cancel()
})
