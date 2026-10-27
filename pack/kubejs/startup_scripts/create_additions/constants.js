// priority: -100
"use strict";

global.CREATE_ADDITIONS_DISABLED_ITEMS = [
    'createaddition:electrum_ingot',
    'createaddition:electrum_nugget',
    'createaddition:electrum_amulet',
    'createaddition:biomass_pellet',
    'createaddition:diamond_grit',
    'createaddition:biomass',
    'createaddition:creative_energy',
    'createaddition:electrum_rod',
    'createaddition:gold_rod',
    'createaddition:copper_rod',
    'createaddition:iron_rod',
    'createaddition:brass_rod',
    'createaddition:electrum_sheet',
    'createaddition:zinc_sheet',
    'createaddition:seed_oil_bucket',
    'createaddition:bioethanol_bucket',
    'createaddition:biomass_pellet_block',
    'createaddition:festive_spool',
    'createaddition:electrum_block',
    'createaddition:straw'

    // Провода/коннекторы/катушки (connector, large_connector, small_light_connector,
    // copper/iron/gold/electrum_wire, spool + copper/gold/electrum_spool, capacitor,
    // redstone_relay, tesla_coil) намеренно убраны из этого списка: в ванильном
    // createaddition 1.3.3 у *_wire вообще нет рецепта (ни одного jar/data-рецепта),
    // поэтому вся электросеть была нерабочей "из коробки", и её просто вырезали
    // целиком. Рецепты для них добавлены заново в server_scripts/create_additions/recipes.js.
];
