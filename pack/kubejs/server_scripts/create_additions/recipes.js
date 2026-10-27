// priority: 0
"use strict";

const registerCreateAdditionsRecipes = (event) => {

	// Удаление рецептов 
	event.remove({ mod: 'createaddition' });

	// Прокатный стан
	event.recipes.gtceu.shaped('createaddition:rolling_mill', [
		'ABA',
		'CEC',
		'DBD'
	], {
		A: 'create:precision_mechanism',
		B: '#forge:rods/long/blue_steel',
		C: '#forge:double_plates/black_steel',
		D: '#gtceu:circuits/ulv',
		E: 'gtceu:ulv_machine_hull'
	}).addMaterialInfo().id('tfg:create_additions/shaped/rolling_mill')

	// Цифровой адаптер
	event.recipes.gtceu.shaped('createaddition:digital_adapter', [
		'ABA',
		'BCB',
		'ABA'
	], {
		A: '#forge:plates/brass',
		B: 'gtceu:red_alloy_single_wire',
		C: 'computercraft:wired_modem',
	}).addMaterialInfo().id('tfg:create_additions/shaped/digital_adapter')

	// Колючая проволка
	event.shapeless('4x createaddition:barbed_wire', [
		'#forge:rods/wrought_iron',
		'#forge:rods/long/wrought_iron',
		'#forge:rods/wrought_iron',
		'#forge:rods/long/wrought_iron',
		'#forge:rods/wrought_iron',
		'#forge:rods/long/wrought_iron',
		'#forge:rods/wrought_iron',
		'#forge:rods/long/wrought_iron',
		'#forge:tools/hammers'
	]).id('tfg:create_additions/shapeless/barbed_wire')

	event.recipes.gtceu.assembler('tfg:createaddition/barbed_wire')
		.itemInputs('4x #forge:rods/wrought_iron', '4x #forge:rods/long/wrought_iron')
		.circuit(3)
		.itemOutputs('4x createaddition:barbed_wire')
		.duration(200)
		.EUt(20)
		.addMaterialInfo(true)

	event.recipes.gtceu.shaped('createaddition:electric_motor', [
		'CCC',
		'BDA',
		'CCC'
	], {
		A: 'gtceu:ulv_voltage_coil',
		B: 'create:rotation_speed_controller',
		C: 'gtceu:tin_single_cable',
		D: 'gtceu:lv_electric_motor',
	}).addMaterialInfo().id('tfg:createadditions/shaped/electric_motor')

	event.recipes.gtceu.shaped('createaddition:alternator', [
		'ABA',
		'CDC',
		'EFE'
	], {
		A: '#gtceu:resistors',
		B: '#gtceu:circuits/lv',
		C: 'gtceu:ulv_voltage_coil',
		D: 'gtceu:ulv_machine_hull',
		E: 'gtceu:tin_single_cable',
		F: '#forge:shafts'
	}).addMaterialInfo().id('tfg:createadditions/shaped/alternator')

	
	event.shapeless('createaddition:diamond_grit_sandpaper', ['minecraft:paper', 'tfc:glue', '#forge:dusts/diamond'])
		.id('tfg:shapeless/diamond_grit_sand_paper')


	event.recipes.gtceu.shaped('createaddition:portable_energy_interface', [
		'ABC',
		'DEC',
		'ADC'
	], {
		A: '#forge:plates/brass',
		B: 'create:chute',
		C: 'gtceu:copper_octal_wire',
		D: 'gtceu:copper_single_cable',
		E: 'create:brass_casing'
	}).addMaterialInfo().id('tfg:create_additions/shaped/portable_energy_interface')

	event.recipes.gtceu.assembler('create_additions/battery_hv')
		.itemInputs('2x gtceu:industrial_steam_casing', '#gtceu:batteries/hv')
		.itemOutputs('2x createaddition:modular_accumulator')
		.duration(400)
		.EUt(30)

	event.recipes.gtceu.assembler('create_additions/battery_mv')
		.itemInputs('gtceu:industrial_steam_casing', '2x #gtceu:batteries/mv')
		.itemOutputs('createaddition:modular_accumulator')
		.duration(400)
		.EUt(30)

	event.recipes.gtceu.assembler('create_additions/battery_lv')
		.itemInputs('gtceu:industrial_steam_casing', '8x #gtceu:batteries/lv')
		.itemOutputs('createaddition:modular_accumulator')
		.duration(400)
		.EUt(30)
		.addMaterialInfo(true)

	// ==========================================================================
	// Электросеть Create Additions: провода, коннекторы, катушки
	//
	// В ванильном createaddition 1.3.3 предметы *_wire (copper/iron/gold/electrum)
	// не имеют НИ ОДНОГО рецепта - ни в data/createaddition/recipes, ни в компат-папках
	// других модов. Они существуют только как заполнители тегов forge:wires/<металл>,
	// которые используются в рецептах катушек (spool). Без рецепта на сам провод вся
	// цепочка connector -> spool -> линковка проводом была нерабочей "из коробки",
	// поэтому пак и вырезал её целиком. Здесь рецепты добавлены заново.
	//
	// Как это работает в игре (сам мод): коннектор (connector/large_connector) вешается
	// на блок с Forge Energy (по умолчанию режим None, ПКМ гаечным ключом = Push/Pull/None).
	// Затем ПКМ по коннектору с катушкой (spool) в руке, затем ПКМ по второму коннектору -
	// между ними протягивается провод и передаёт FE. Катушка не расходуется, а хранит связь;
	// повторный ПКМ по обоим коннекторам снимает провод. Обычный connector держит до 4 связей
	// и провода низкого тока (copper/iron_wire), large_connector - до 6 связей и провода
	// высокого тока (gold/electrum_wire). redstone_relay - повторитель/клапан на редстоун-сигнал,
	// tesla_coil - беспроводная зарядка предметов под собой (и урон по редстоун-сигналу).

	// --- Провод: как у самого GTCEU - лист + кусачки (тег не расходуется, тратит прочность,
	// как и #forge:tools/hammers по всему паку). Никакого стана - это ручной, самый ранний
	// способ получить провод в Греге, тем же путём, каким игрок и так их уже делает. ---
	event.shapeless('createaddition:copper_wire', [
		'#forge:plates/copper',
		'#forge:tools/wire_cutters'
	]).id('tfg:create_additions/shapeless/copper_wire')

	event.shapeless('createaddition:iron_wire', [
		'#forge:plates/wrought_iron',
		'#forge:tools/wire_cutters'
	]).id('tfg:create_additions/shapeless/iron_wire')

	event.shapeless('createaddition:gold_wire', [
		'#forge:plates/gold',
		'#forge:tools/wire_cutters'
	]).id('tfg:create_additions/shapeless/gold_wire')

	event.shapeless('createaddition:electrum_wire', [
		'#forge:plates/electrum',
		'#forge:tools/wire_cutters'
	]).id('tfg:create_additions/shapeless/electrum_wire')

	// --- Коннекторы: тот же костяк, что в ваниле (прут + липкое), андезитовый сплав
	// заменён на gtceu:tin_single_cable - тот же "провод"-компонент, что уже используется
	// в electric_motor/alternator этого пака. create:andesite_alloy трогать нельзя -
	// его крафт целиком вырезан в greate/recipes.removes.js (GREATE_DISABLED_ITEMS).
	// Слизь -> tfc:glue напрямую: глобальный event.replaceInput в tfc/recipes.js меняет
	// только конкретный minecraft:slime_ball, а не тег #forge:slimeballs, поэтому тег
	// тут не работает - через тег игра требовала бы настоящую слизь. ---
	event.shapeless('3x createaddition:connector', [
		'#forge:rods/copper',
		'gtceu:tin_single_cable',
		'tfc:glue'
	]).id('tfg:create_additions/shapeless/connector')

	event.shapeless('2x createaddition:large_connector', [
		'#forge:rods/gold',
		'gtceu:tin_single_cable',
		'gtceu:tin_single_cable',
		'tfc:glue'
	]).id('tfg:create_additions/shapeless/large_connector_gold')

	event.shapeless('2x createaddition:large_connector', [
		'#forge:rods/electrum',
		'gtceu:tin_single_cable',
		'gtceu:tin_single_cable',
		'tfc:glue'
	]).id('tfg:create_additions/shapeless/large_connector_electrum')

	event.shapeless('createaddition:small_light_connector', [
		'createaddition:iron_wire',
		'#forge:glass',
		'createaddition:connector'
	]).id('tfg:create_additions/shapeless/small_light_connector')

	// --- Катушки: пустая катушка + намотка соответствующим проводом ---
	event.recipes.gtceu.shaped('16x createaddition:spool', [
		'P',
		'N',
		'P'
	], {
		P: '#forge:plates/wrought_iron',
		N: '#forge:nuggets/wrought_iron',
	}).addMaterialInfo().id('tfg:create_additions/shaped/spool')

	event.recipes.gtceu.shaped('createaddition:copper_spool', [
		' W ',
		'WSW',
		' W '
	], {
		W: 'createaddition:copper_wire',
		S: 'createaddition:spool',
	}).addMaterialInfo().id('tfg:create_additions/shaped/copper_spool')

	event.recipes.gtceu.shaped('createaddition:gold_spool', [
		' W ',
		'WSW',
		' W '
	], {
		W: 'createaddition:gold_wire',
		S: 'createaddition:spool',
	}).addMaterialInfo().id('tfg:create_additions/shaped/gold_spool')

	event.recipes.gtceu.shaped('createaddition:electrum_spool', [
		' W ',
		'WSW',
		' W '
	], {
		W: 'createaddition:electrum_wire',
		S: 'createaddition:spool',
	}).addMaterialInfo().id('tfg:create_additions/shaped/electrum_spool')

	// --- Конденсатор (ингредиент реле и катушки Теслы) ---
	event.recipes.gtceu.shaped('createaddition:capacitor', [
		'Z',
		'C',
		'T'
	], {
		Z: '#forge:plates/zinc',
		C: '#forge:plates/copper',
		T: 'minecraft:redstone_torch',
	}).addMaterialInfo().id('tfg:create_additions/shaped/capacitor')

	// --- Редстоун-реле: клапан/повторитель на сети проводов ---
	event.recipes.gtceu.shaped('createaddition:redstone_relay', [
		' R ',
		'CEC',
		'SSS'
	], {
		R: '#forge:dusts/redstone',
		C: 'createaddition:connector',
		E: 'create:electron_tube',
		S: '#forge:stone',
	}).addMaterialInfo().id('tfg:create_additions/shaped/redstone_relay')

	// --- Катушка Теслы: механическая сборка, andesite_alloy заменён на ulv_voltage_coil ---
	event.recipes.createMechanicalCrafting('createaddition:tesla_coil', [
		'SSS',
		' A ',
		'CBC',
		'PEP'
	], {
		S: 'createaddition:copper_spool',
		A: 'gtceu:ulv_voltage_coil',
		C: 'createaddition:capacitor',
		B: 'create:brass_casing',
		P: '#forge:plates/brass',
		E: 'create:electron_tube',
	}).id('tfg:create_additions/mechanical_crafting/tesla_coil')
}
