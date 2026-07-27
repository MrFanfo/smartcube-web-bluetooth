import { describe, it, expect } from 'vitest';
import { FIXTURES, loadFixture } from '../../test/fixtures';
import { installMockBluetoothFromFixture } from '../../test/bluetooth-mock';
import { serviceUuidsFromFixture } from '../../test/helpers/fixture-replay';
import { collectEvents, fixtureExpectedLastFacelets, fixtureExpectedMoves, lastFacelets, moves } from '../../test/helpers/events';
import { qiyiProtocol } from './qiyi';

describe('qiyiProtocol.connect (capture replay)', () => {
  it('matches fixture decoded events', async () => {
    const fixture = await loadFixture(FIXTURES.qiyi);
    const { device, replayer } = installMockBluetoothFromFixture(fixture, { deviceId: 'qiyi-replay' });

    const conn = await qiyiProtocol.connect(
      device,
      async () => fixture.device.mac ?? null,
      {
        serviceUuids: serviceUuidsFromFixture(fixture),
        advertisementManufacturerData: null,
        enableAddressSearch: false,
        onStatus: undefined,
        signal: undefined,
      }
    );

    const { events, unsubscribe } = collectEvents(conn);

    await replayer.drainNotificationsAsync();
    unsubscribe();

    const expectedMoves = fixtureExpectedMoves(fixture, 25);
    const expectedLast = fixtureExpectedLastFacelets(fixture);
    expect(moves(events).slice(0, expectedMoves.length)).toEqual(expectedMoves);
    expect(lastFacelets(events)).toBe(expectedLast);

    await conn.disconnect();
  }, 20_000);

  it('resynchronizes from packet facelets when move history cannot cover a notification gap', async () => {
    const fixture = await loadFixture(FIXTURES.qiyi);
    const stateNotifications = fixture.traffic.filter(
      (entry) => entry.op === 'notify' && entry.data?.length === 192,
    );
    const target = stateNotifications[12]!;
    const expectedFacelets = fixture.events.find(
      (entry) => entry.t >= target.t && entry.event.type === 'FACELETS',
    )?.event.facelets as string | undefined;
    expect(expectedFacelets).toBeDefined();

    const gapFixture = {
      ...fixture,
      traffic: fixture.traffic.filter((entry) => {
        if (entry.t > target.t) return false;
        const isStateNotification = entry.op === 'notify' && entry.data?.length === 192;
        return !isStateNotification || entry === target;
      }),
    };
    const { device, replayer } = installMockBluetoothFromFixture(gapFixture, {
      deviceId: 'qiyi-gap-replay',
    });

    const conn = await qiyiProtocol.connect(
      device,
      async () => fixture.device.mac ?? null,
      {
        serviceUuids: serviceUuidsFromFixture(fixture),
        advertisementManufacturerData: null,
        enableAddressSearch: false,
        onStatus: undefined,
        signal: undefined,
      }
    );
    const { events, unsubscribe } = collectEvents(conn);

    await replayer.drainNotificationsAsync();
    unsubscribe();

    // csTimer recovers the current move plus nine history entries. The
    // authoritative facelets must repair the older moves outside that window.
    expect(moves(events)).toHaveLength(10);
    expect(lastFacelets(events)).toBe(expectedFacelets);

    await conn.disconnect();
  }, 20_000);
});
