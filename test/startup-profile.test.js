import test from 'node:test';
import assert from 'node:assert/strict';

import { buildBotConfig, farmTradingConfig } from '../src/startup-profile.js';

test('farmTradingConfig enables seller-side trading while keeping human cadence', () => {
  const cfg = farmTradingConfig();

  assert.equal(cfg.autoSellGold, true);
  assert.equal(cfg.autoSellJunk, true);
  assert.equal(cfg.autoSellJunkRelics, false);
  assert.equal(cfg.autoSellJunkCreatures, true); // 2026-07-05: owner задепнул 10 кошельков >10k ZOLANA — продажа Uncommon+Rare включена (per-account гейтится marketSellMinZolana)
  assert.equal(cfg.autoRecycleCreatures, true);   // Common → XP
  assert.equal(cfg.recycleProtectSpecialVariants, true);
  assert.equal(cfg.cashoutPriceJitterPct, 0.03); // Task-1: цена существ ±3% вокруг floor (органично, не undercut-стена)
  assert.equal(cfg.cashoutUndercutPctMin, 0); // 2026-07-06 вечер: слив −25..35% заменён demand-моделью
  assert.equal(cfg.cashoutUndercutPctMax, 0);
  assert.equal(cfg.cashoutDemandPricing, true); // цена = медиана реальных продаж → под чужой аск → seed; свой флот не подрезаем
  assert.equal(cfg.cashoutAskUndercutPct, 0.05);
  assert.equal(cfg.cashoutRepriceDecayPct, 0.12); // залежался час → −12% от своей цены, ступенями до уровня спроса
  assert.equal(cfg.cashoutMinPriceUsd, 0.01);    // дефолт $0.05 клампил бы скидку ВЫШЕ флора uncommon (~$0.02-0.03)
  assert.equal(cfg.cashoutMaxPriceOverFloor, 10); // 2026-07-06: sanity cap — thin/outlier clearing gave $1.67 на $0.05 floor
  assert.equal(cfg.cashoutListChance, 0.6);      // Task-1: хаотичный момент листинга (не clockwork)
  assert.equal(cfg.autoVaultWhenFull, true);     // «рарки в сейф» когда ростер полон
  assert.equal(cfg.autoVaultSwap, true);         // 2026-07-05: continuous флот↔сейф полировка состава
  assert.equal(cfg.autoBreedingPipeline, true);  // 2026-07-06: выделенный брид-пайплайн в сейфе
  assert.deepEqual(cfg.vaultBreedingRarities, ['uncommon', 'rare', 'epic']); // 2026-07-06: owner — «надо чтоб епик тоже бридились»
  assert.equal(cfg.junkMinBreedCount, 8);
  assert.equal(cfg.junkSurplusKeepPerSpecies, 4); // 2026-07-06: излишек сверх 2 брид-пар продаётся сразу, не ждёт 8/8
  assert.equal(cfg.breedAllowCrossSpecies, false); // 2026-07-06: строго same-species (друг: «одна порода, одна рарность, один тир, у обоих»)
  assert.deepEqual(cfg.junkVariantRarityOverrides, ['uncommon:rainbow', 'uncommon:golden', 'uncommon:shadow', 'uncommon:shiny']); // 2026-07-07: все спец-варианты анкамона продаём (per-trait floor)
  assert.equal(cfg.recycleCommonVariantsToXp, true);  // 2026-07-07: Golden/Shadow commons → XP (кроме Rainbow)
  assert.equal(cfg.cashoutVariantPremiumPct, 0.1);    // спец-варианты на ~10% выше своего трейт-флора
  assert.equal(cfg.autoForgeTrainerRelic, true); // Task-2: форж trainer-реликвий
  assert.equal(cfg.relicMaxActionsPerTick, 15);  // 2026-07-06: батч-кап, чтобы разовый бэклог не блокировал данжи
  assert.equal(cfg.forgeMinGold, 400000);        // форж защищает egg/breed-бюджет
  assert.equal(cfg.cashoutGoldReserve, 500_000);  // 2026-07-06: owner — копим до 1.5М, сливаем 1М, резерв 500к
  assert.equal(cfg.cashoutGoldSellTrigger, 1_500_000); // гистерезис-триггер старта продажи (не reserve+minLot=600k)
  assert.equal(cfg.cashoutMinLotGold, 100_000);   // «по 100к+» — было 50к (базовый дефолт), из-за чего золото НИ РАЗУ не продалось за сессию
  assert.equal(cfg.cashoutChunkFracMin, 0.08);
  assert.equal(cfg.cashoutChunkFracMax, 0.14);    // при surplus≈1М (golд=1.5М) → лоты ~80-140к, «постепенно по 100к»
  assert.equal(cfg.cashoutGoldWeight, 1);
  assert.equal(cfg.cashoutCreatureWeight, 3);     // активно листим Uncommon
  assert.equal(cfg.cashoutMaxActiveListings, 3);
  assert.equal(cfg.cashoutMaxActiveCreatureListings, 9);
  assert.equal(cfg.cashoutPriceJitterMin, 1);
  assert.equal(cfg.cashoutPriceJitterMax, 1);
  assert.equal(cfg.cashoutRepriceEnabled, true);
  assert.equal(cfg.cashoutRepriceMinAgeMs, 60 * 60 * 1000); // релист раз в ~час
  assert.equal(cfg.cashoutRepriceMinDropPct, 0.05);
  assert.equal(cfg.marketSellMinZolana, 10_000);            // серверный гейт листинга — акки <10k тихо ждут, не спамят 403
  assert.equal(cfg.autoSellDuringScaling, true);            // тянем токены во время кача
  assert.equal(cfg.cashoutTargetZolana, 100_000);           // верхний стоп на кошелёк
  assert.ok(Array.isArray(cfg.fleetWallets));               // свои кошельки исключаются из floor
  assert.deepEqual(cfg.junkCreatureRarities, ['uncommon', 'rare']); // 2026-07-07: продаём излишек рарок тоже (keep-4/species остаётся брид-стоком)
  assert.equal(cfg.breedHighRarityFirst, true); // 2026-07-07: брид сверху-вниз — растим эпики/леги (было bottom-up → 0 epic breeds/24h)
  assert.deepEqual(cfg.junkCreatureStages, ['Baby', 'Juvenile', 'Adult', 'Elder']);
  assert.equal(cfg.junkCreatureKeepPerSpecies, 0); // продаём всех, не держим
  assert.equal(cfg.autoBuyEggs, false); // 2026-07-06 (owner, ФИНАЛ): «надо фулл убрать, чтоб яйца не покупало» — выключено полностью, включая lux; рост только через брид
  assert.equal(cfg.eggQueueTarget, 6);
  assert.equal(cfg.vaultBreedingPoolTarget, 500); // vault nursery raised to the max (owner) — server storage caps it; runner core protected in pickBreedingIntake
  assert.equal(cfg.vaultIntakeMaxPerTick, 5);    // батч-впуск (по одному в 10-20 мин — ~10 часов на разгрузку)
  assert.equal(cfg.autoEnhanceRelics, true); // 2026-07-06 (друг): качаем trainer-реликвии «сразу на два уровня»
  assert.deepEqual(cfg.enhanceRelicClasses, ['trainer']); // ТОЛЬКО trainer (их 3/акк) — пет-реликвий 200+, качать всех разорительно
  assert.equal(cfg.enhanceMinGold, 300000); // защита egg/breed-бюджета (по образцу forgeMinGold)
  assert.equal(cfg.enhanceMaxLevel, 2); // выше +2 не качаем
  assert.equal(cfg.feedMaxPerTick, 10); // 2026-07-06: 30+ Baby после egg-бёрста — кап 3 душил взросление брид-стока
  assert.equal(cfg.breedMaxPendingEggs, 6); // покупных яиц нет → все 6 слотов инкубатора под брид-яйца (был кап 3 — клапан против монополизации)
  assert.equal(cfg.breedMaxPerTick, 3); // до 3 пар за вызов — пул из 10 бридеров давал до 5 готовых пар, одна попытка/10мин оставляла их простаивать
  assert.equal(cfg.autoBuyStamina, true);
  assert.equal(cfg.optimizeDepth, true);
  assert.equal(cfg.depthObjective, 'gold-per-run');
});

test('buildBotConfig merges live strategy and jitter with shared trading defaults', () => {
  const cfg = buildBotConfig({
    name: 'Zephyr',
    strategy: { depth: 7, depthCeiling: 9 },
    jitter: {
      seed: 123,
      tickMinSec: 31,
      tickMaxSec: 74,
      actionDelayMinMs: 501,
      actionDelayMaxMs: 1501,
    },
  });

  assert.equal(cfg.name, 'Zephyr');
  assert.equal(cfg.depth, 7);
  assert.equal(cfg.depthCeiling, 9);
  assert.equal(cfg.tickMinSec, 31);
  assert.equal(cfg.tickMaxSec, 74);
  assert.equal(cfg.actionDelayMinMs, 501);
  assert.equal(cfg.actionDelayMaxMs, 1501);
  assert.equal(cfg.autoSellGold, true);
  assert.equal(cfg.autoSellJunk, true);
  assert.equal(typeof cfg.rng, 'function');
});

test('buildBotConfig allows explicit overrides for controlled experiments', () => {
  const cfg = buildBotConfig({
    name: 'Zephyr',
    jitter: {
      seed: 1,
      tickMinSec: 45,
      tickMaxSec: 120,
      actionDelayMinMs: 400,
      actionDelayMaxMs: 1600,
    },
    overrides: { autoSellGold: false, cashoutMaxActiveListings: 1 },
  });

  assert.equal(cfg.autoSellGold, false);
  assert.equal(cfg.autoSellJunk, true);
  assert.equal(cfg.cashoutMaxActiveListings, 1);
});
