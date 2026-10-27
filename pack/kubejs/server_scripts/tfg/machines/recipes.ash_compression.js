// priority: 0
"use strict";

/**
 * Зола (gtceu:ash_dust) прессованием деревесной золы TFC.
 *
 * Зола - сырьё магнезии в цепочке купроникелевой катушки: центрифуга
 * gtceu:ash_separation выдаёт из неё магнезию (а также негашёную известь, поташ...).
 * Штатно золу дают только центрифуга пепла и шансовые побочки, поэтому она
 * оказалась одним из самых дорогих материалов. Деревесная зола копится с костров.
 *
 * Соотношение 2:1 - правится здесь.
 * Файл самостоятельный: свой ServerEvents.recipes, в main_server_script.js не подключается.
 */
ServerEvents.recipes(event => {
	event.recipes.gtceu.compressor('tfg:ash_dust_from_wood_ash')
		.itemInputs('2x tfc:powder/wood_ash')
		.itemOutputs('gtceu:ash_dust')
		.duration(100)
		.EUt(2)
})
