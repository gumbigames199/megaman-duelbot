export const CHIPS = {
  Spreader1: { kind: 'attack', dmg: 30 },
  Vulcan1: { kind: 'attack', dmg: 30 },
  Cannon1: { kind: 'attack', dmg: 40 },
  Sword: { kind: 'attack', dmg: 80 },
  WideSword: { kind: 'attack', dmg: 80 },
  ElecSword: { kind: 'attack', dmg: 90 },
  LongSword: { kind: 'attack', dmg: 100 },
  ElecMan1: { kind: 'attack', dmg: 120 },
  TorchMan1: { kind: 'attack', dmg: 150 },
  Barrier: { kind: 'barrier' },
  RockCube: {kind: 'defense', def: 40 },
  Roll1: {kind: 'recovery', heal:120 }
};

export const UPGRADES = {
  'HP Memory': { stat: 'hp', step: 50, max: 500 },
  'Data Reconfig': { stat: 'dodge', step: 5, max: 40 },
  'Lucky Data': { stat: 'crit', step: 5, max: 25 }
};
