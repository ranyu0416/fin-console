/** 台账模块注册表。新增模块只需在这里加一行 import 与一个键（scripts/new-module.mjs 会自动改）。 */
import { facility } from './facility.js';
import { levy } from './levy.js';
import { union } from './union.js';
import { asset } from './asset.js';
import { baddebt } from './baddebt.js';
import { lvc } from './lvc.js';
import { balance } from './balance.js';
import { rnd } from './rnd.js';
import { labor } from './labor.js';
import { contract } from './contract.js';
import { party } from './party.js';
import { staffpay } from './staffpay.js';
import { invoice } from './invoice.js';
import { bank } from './bank.js';
import { deposit } from './deposit.js';
import { material } from './material.js';
import { machinery } from './machinery.js';
import { consumable } from './consumable.js';

export const MODULES = { facility, levy, union, asset, baddebt, lvc, balance, rnd, labor, contract, party, staffpay, invoice, bank, deposit, material, machinery, consumable };
