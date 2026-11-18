import { savePaymentRecovery, readPaymentRecovery } from '../../src/features/store/payment-recovery.ts';
const memory = new Map();
globalThis.localStorage={getItem:key=>memory.get(key)??null,setItem:(key,value)=>memory.set(key,value)};
const first={order:{actionId:'10000000-0000-4000-8000-000000000001'},recoveryToken:'a'.repeat(43),recoveryExpiresAt:'2099-11-27T12:00:00Z'};
const second={order:{actionId:'10000000-0000-4000-8000-000000000002'},recoveryToken:'b'.repeat(43),recoveryExpiresAt:'2099-11-27T12:00:00Z'};
savePaymentRecovery('audit-store',first);savePaymentRecovery('audit-store',second);
const requestedReturn=new URL('https://example.test/t/audit-store/pago?order='+first.order.actionId);
const restored=readPaymentRecovery('audit-store');
console.log(JSON.stringify({test:'two_payment_recovery_capabilities',returnOrder:requestedReturn.searchParams.get('order'),restoredOrder:restored.actionId,matchesRequestedOrder:requestedReturn.searchParams.get('order')===restored.actionId,storedRecords:memory.size}));
