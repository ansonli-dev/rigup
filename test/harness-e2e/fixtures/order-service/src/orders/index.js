import {cancelOrder} from './cancel.js';
import {createOrder} from './create.js';
import {shipOrder} from './ship.js';

export const operations = {create: createOrder, cancel: cancelOrder, ship: shipOrder};
