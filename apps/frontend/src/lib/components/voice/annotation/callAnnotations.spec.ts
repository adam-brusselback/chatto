import { describe, expect, it } from 'vitest';
import { ANNOTATION_TOPIC_LOSSY, ANNOTATION_TOPIC_RELIABLE, ClearScope } from './annotationCodec';
import { deriveAnnotationKey } from './annotationCrypto';
import { CallAnnotations } from './callAnnotations';
import { ANNOTATION_PALETTE, colorForIndex, identityColorIndex } from './palette';
import type { NormalizedPoint } from './types';

interface Sent {
  data: Uint8Array;
  reliable: boolean;
  topic: string;
}

async function makeParticipants() {
  const key = await deriveAnnotationKey('call-secret');
  const sent: Sent[] = [];
  const alice = new CallAnnotations(key, 'alice', (data, reliable, topic) =>
    sent.push({ data, reliable, topic })
  );
  const bob = new CallAnnotations(key, 'bob', () => {});
  return { key, alice, bob, sent };
}

const BOARD = 'sharer-1';
const POINTS: NormalizedPoint[] = [
  { x: 0.1, y: 0.2 },
  { x: 0.3, y: 0.4 }
];

describe('CallAnnotations', () => {
  it('publishes a commit reliably and records it for the local drawer', async () => {
    const { alice, sent } = await makeParticipants();
    await alice.publishStrokeCommit(BOARD, 7, 2, 5, POINTS);

    expect(sent).toHaveLength(1);
    expect(sent[0].reliable).toBe(true);
    expect(sent[0].topic).toBe(ANNOTATION_TOPIC_RELIABLE);

    const own = alice.committedStrokes(BOARD);
    expect(own).toHaveLength(1);
    expect(own[0].color).toBe(ANNOTATION_PALETTE[2]);
    expect(own[0].size).toBe(5);
  });

  it('mirrors a committed stroke to another participant', async () => {
    const { alice, bob, sent } = await makeParticipants();
    await alice.publishStrokeCommit(BOARD, 7, 3, 4, POINTS);
    await bob.handleData(sent[0].data, 'alice', sent[0].topic);

    const strokes = bob.committedStrokes(BOARD);
    expect(strokes).toHaveLength(1);
    expect(strokes[0].color).toBe(ANNOTATION_PALETTE[3]);
    expect(strokes[0].points).toHaveLength(2);
    expect(strokes[0].points[0].x).toBeCloseTo(0.1, 3);
    expect(strokes[0].points[1].y).toBeCloseTo(0.4, 3);
  });

  it('attributes strokes with an author-derived halo color', async () => {
    const { alice, bob, sent } = await makeParticipants();
    await alice.publishStrokeCommit(BOARD, 1, 0, 4, POINTS);
    await bob.handleData(sent[0].data, 'alice', ANNOTATION_TOPIC_RELIABLE);
    await alice.publishStrokeCommit(BOARD, 2, 0, 4, POINTS);
    await bob.handleData(sent[1].data, 'carol-with-a-different-hash', ANNOTATION_TOPIC_RELIABLE);

    const strokes = bob.committedStrokes(BOARD);
    expect(strokes).toHaveLength(2);
    const halos = strokes.map((stroke) => stroke.haloColor);
    expect(halos[0]).toBe(colorForIndex(identityColorIndex('alice')));
    expect(halos[1]).toBe(colorForIndex(identityColorIndex('carol-with-a-different-hash')));
    // The sender's own record carries their halo too.
    expect(alice.committedStrokes(BOARD)[0].haloColor).toBe(
      colorForIndex(identityColorIndex('alice'))
    );
  });

  it('routes a lossy delta as a pending stroke, then a commit finalizes it', async () => {
    const { alice, bob, sent } = await makeParticipants();

    await alice.publishStrokeDelta(BOARD, 1, 0, 4, 0, POINTS);
    expect(sent[0].reliable).toBe(false);
    expect(sent[0].topic).toBe(ANNOTATION_TOPIC_LOSSY);

    await bob.handleData(sent[0].data, 'alice', ANNOTATION_TOPIC_LOSSY);
    expect(bob.pendingStrokes(BOARD)).toHaveLength(1);
    expect(bob.committedStrokes(BOARD)).toHaveLength(0);

    const full = [...POINTS, { x: 0.5, y: 0.6 }];
    await alice.publishStrokeCommit(BOARD, 1, 0, 4, full);
    await bob.handleData(sent[1].data, 'alice', ANNOTATION_TOPIC_RELIABLE);
    expect(bob.pendingStrokes(BOARD)).toHaveLength(0);
    expect(bob.committedStrokes(BOARD)).toHaveLength(1);
    expect(bob.committedStrokes(BOARD)[0].points).toHaveLength(3);
  });

  it('bumps the revision when a committed stroke arrives', async () => {
    const { alice, bob, sent } = await makeParticipants();
    const before = bob.revision;
    await alice.publishStrokeCommit(BOARD, 1, 0, 4, POINTS);
    await bob.handleData(sent[0].data, 'alice', ANNOTATION_TOPIC_RELIABLE);
    expect(bob.revision).toBeGreaterThan(before);
  });

  it('clears the whole board on a board-scoped clear', async () => {
    const { alice, bob, sent } = await makeParticipants();
    await alice.publishStrokeCommit(BOARD, 1, 0, 4, POINTS);
    await bob.handleData(sent[0].data, 'alice', ANNOTATION_TOPIC_RELIABLE);
    expect(bob.committedStrokes(BOARD)).toHaveLength(1);

    await alice.publishClear(BOARD, ClearScope.Board);
    await bob.handleData(sent[1].data, 'alice', ANNOTATION_TOPIC_RELIABLE);
    expect(bob.committedStrokes(BOARD)).toHaveLength(0);
  });

  it('removes only the sender-owned strokes on an own-scoped clear', async () => {
    const { alice, bob, sent } = await makeParticipants();
    // Bob learns strokes from both alice and carol.
    await alice.publishStrokeCommit(BOARD, 1, 0, 4, POINTS);
    await bob.handleData(sent[0].data, 'alice', ANNOTATION_TOPIC_RELIABLE);
    await alice.publishStrokeCommit(BOARD, 2, 1, 4, POINTS);
    await bob.handleData(sent[1].data, 'carol', ANNOTATION_TOPIC_RELIABLE);
    expect(bob.committedStrokes(BOARD)).toHaveLength(2);

    // Alice clears her own strokes only.
    await alice.publishClear(BOARD, ClearScope.Own);
    await bob.handleData(sent[2].data, 'alice', ANNOTATION_TOPIC_RELIABLE);
    expect(bob.committedStrokes(BOARD)).toHaveLength(1);
  });

  it('ignores packets on an unrelated topic', async () => {
    const { alice, bob, sent } = await makeParticipants();
    await alice.publishStrokeCommit(BOARD, 1, 0, 4, POINTS);
    await bob.handleData(sent[0].data, 'alice', 'chatto/other');
    expect(bob.committedStrokes(BOARD)).toHaveLength(0);
  });

  it('drops packets it cannot decrypt', async () => {
    const { alice, sent } = await makeParticipants();
    const eveKey = await deriveAnnotationKey('a-different-secret');
    const eve = new CallAnnotations(eveKey, 'eve', () => {});
    await alice.publishStrokeCommit(BOARD, 1, 0, 4, POINTS);
    await eve.handleData(sent[0].data, 'alice', ANNOTATION_TOPIC_RELIABLE);
    expect(eve.committedStrokes(BOARD)).toHaveLength(0);
  });

  it('ignores a corrupt payload without throwing', async () => {
    const { bob } = await makeParticipants();
    await bob.handleData(new Uint8Array([1, 2, 3, 4, 5]), 'alice', ANNOTATION_TOPIC_RELIABLE);
    expect(bob.committedStrokes(BOARD)).toHaveLength(0);
  });

  it('allocates unique stroke ids per controller', async () => {
    const { alice } = await makeParticipants();
    const first = alice.nextStrokeId();
    const second = alice.nextStrokeId();
    expect(second).not.toBe(first);
  });

  it('routes laser positions with sender color and age', async () => {
    const { alice, bob, sent } = await makeParticipants();
    await alice.publishLaser(BOARD, 0.25, 0.75, 5, true);
    expect(sent[0].reliable).toBe(false);
    expect(sent[0].topic).toBe(ANNOTATION_TOPIC_LOSSY);

    await bob.handleData(sent[0].data, 'alice', ANNOTATION_TOPIC_LOSSY);
    const lasers = bob.lasers(BOARD);
    expect(lasers).toHaveLength(1);
    expect(lasers[0].sender).toBe('alice');
    expect(lasers[0].colorIndex).toBe(5);
    expect(lasers[0].active).toBe(true);
    expect(lasers[0].x).toBeCloseTo(0.25, 3);
    expect(lasers[0].ageMs).toBeGreaterThanOrEqual(0);

    await alice.publishLaser(BOARD, 0.5, 0.5, 5, false);
    await bob.handleData(sent[1].data, 'alice', ANNOTATION_TOPIC_LOSSY);
    expect(bob.lasers(BOARD)[0].active).toBe(false);
  });

  it('applies draw-together control frames and reports them via onControlChange', async () => {
    const { alice, bob, sent } = await makeParticipants();
    const seen: Array<{ boardId: string; enabled: boolean }> = [];
    bob.onControlChange = (boardId, enabled) => seen.push({ boardId, enabled });

    expect(bob.isDrawTogetherEnabled(BOARD)).toBe(true);
    await alice.setLocalDrawTogether(BOARD, false);
    expect(alice.isDrawTogetherEnabled(BOARD)).toBe(false);
    expect(sent[0].reliable).toBe(true);

    await bob.handleData(sent[0].data, 'alice', ANNOTATION_TOPIC_RELIABLE);
    expect(bob.isDrawTogetherEnabled(BOARD)).toBe(false);
    expect(seen).toEqual([{ boardId: BOARD, enabled: false }]);
  });

  it('rebroadcasts a set draw-together flag but not the default', async () => {
    const { alice, sent } = await makeParticipants();
    await alice.rebroadcastDrawTogether(BOARD);
    expect(sent).toHaveLength(0);

    await alice.setLocalDrawTogether(BOARD, false);
    await alice.rebroadcastDrawTogether(BOARD);
    expect(sent).toHaveLength(2);
  });

  it('drops a board without publishing', async () => {
    const { alice, bob, sent } = await makeParticipants();
    await alice.publishStrokeCommit(BOARD, 1, 0, 4, POINTS);
    await bob.handleData(sent[0].data, 'alice', ANNOTATION_TOPIC_RELIABLE);
    expect(bob.committedStrokes(BOARD)).toHaveLength(1);

    const sentBefore = sent.length;
    bob.dropBoard(BOARD);
    expect(bob.committedStrokes(BOARD)).toHaveLength(0);
    expect(bob.lasers(BOARD)).toHaveLength(0);
    expect(sent).toHaveLength(sentBefore);
  });

  it('notifies subscribers on inbound changes until unsubscribed', async () => {
    const { alice, bob, sent } = await makeParticipants();
    let notified = 0;
    const unsubscribe = bob.subscribe(() => {
      notified += 1;
    });

    await alice.publishStrokeCommit(BOARD, 1, 0, 4, POINTS);
    await bob.handleData(sent[0].data, 'alice', ANNOTATION_TOPIC_RELIABLE);
    expect(notified).toBe(1);

    unsubscribe();
    await alice.publishStrokeCommit(BOARD, 2, 0, 4, POINTS);
    await bob.handleData(sent[1].data, 'alice', ANNOTATION_TOPIC_RELIABLE);
    expect(notified).toBe(1);
  });
});
