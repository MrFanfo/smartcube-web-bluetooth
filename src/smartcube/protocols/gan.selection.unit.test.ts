import { describe, it, expect } from 'vitest';
import * as def from '../../gan-cube-definitions';
import { normalizeUuid } from '../attachment/normalize-uuid';
import { ganProtocol, getGanGen4ProtocolSelection } from './gan';
import { isGan251DeviceName } from '../../gan251';

describe('ganProtocol.gattAffinity', () => {
  it('prefers gen1 profile when both gen1 services are present', () => {
    const s = new Set<string>([
      normalizeUuid(def.GAN_GEN1_PRIMARY_SERVICE),
      normalizeUuid(def.GAN_GEN1_DEVICE_INFO_SERVICE),
      normalizeUuid(def.GAN_GEN2_SERVICE),
      normalizeUuid(def.GAN_GEN4_SERVICE),
    ]);
    expect(ganProtocol.gattAffinity(s, {} as BluetoothDevice)).toBeGreaterThanOrEqual(125);
  });

  it('returns 0 when no GAN services are present', () => {
    expect(ganProtocol.gattAffinity(new Set(), {} as BluetoothDevice)).toBe(0);
  });

  it('scores gen2/gen3/gen4 services above zero', () => {
    const g2 = new Set([normalizeUuid(def.GAN_GEN2_SERVICE)]);
    const g3 = new Set([normalizeUuid(def.GAN_GEN3_SERVICE)]);
    const g4 = new Set([normalizeUuid(def.GAN_GEN4_SERVICE)]);
    expect(ganProtocol.gattAffinity(g2, {} as BluetoothDevice)).toBeGreaterThan(0);
    expect(ganProtocol.gattAffinity(g3, {} as BluetoothDevice)).toBeGreaterThan(0);
    expect(ganProtocol.gattAffinity(g4, {} as BluetoothDevice)).toBeGreaterThan(0);
  });
});



describe('GAN Gen4 puzzle-family selection', () => {
  it.each([
    'GAN251UI_1234',
    'gan251ui_abcd',
    'GANic251_5678',
  ])('recognizes genuine GAN251 name %s', (name) => {
    expect(isGan251DeviceName(name)).toBe(true);
    const selection = getGanGen4ProtocolSelection(name);
    expect(selection.gan251NameMatched).toBe(true);
    expect(selection.protocol.id).toBe('gan251-ui-v3-2');
    expect(selection.protocol.puzzleFamily).toBe('2x2');
  });

  it.each([
    'GANic4_1234',
    'GAN iCarry 4',
    'GANi4_A26E',
    'GAN251',
    'GANic251',
    '',
  ])('keeps non-GAN251 Gen4 name %s on the normal 3x3 driver', (name) => {
    expect(isGan251DeviceName(name)).toBe(false);
    const selection = getGanGen4ProtocolSelection(name);
    expect(selection.gan251NameMatched).toBe(false);
    expect(selection.protocol.id).toBe('gan-gen4');
    expect(selection.protocol.puzzleFamily).toBe('3x3');
  });
});
