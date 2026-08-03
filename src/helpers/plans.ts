export interface Plan {
  id: 'personal' | 'pro';
  name: string;
  amount: number;
  currency: string;
  frequency: 1;
  frequencyType: 'months';
}

export const PLANS: Record<Plan['id'], Plan> = {
  personal: { id: 'personal', name: 'Vence Personal', amount: 200, currency: 'UYU', frequency: 1, frequencyType: 'months' },
  pro:      { id: 'pro',      name: 'Vence Pro',      amount: 600, currency: 'UYU', frequency: 1, frequencyType: 'months' },
};