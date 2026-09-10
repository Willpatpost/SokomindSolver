function extractScheduleTrace(events, boundaries, boxLabels) {
  const boxCount = boxLabels.length;
  const entries = new Array(boxCount);
  for (let i = 0; i < boxCount; i++) {
    entries[i] = {
      boxIndex: i,
      label: boxLabels[i],
      pushCount: 0,
      phaseCount: 0,
      firstPushIndex: -1,
      lastPushIndex: -1,
      prePushWalking: 0,
    };
  }
  let lastPushedBox = -1;
  for (let i = 0; i < events.length; i++) {
    const event = events[i];
    const entry = entries[event.boxIndex];
    entry.pushCount++;
    if (entry.firstPushIndex === -1) entry.firstPushIndex = i;
    entry.lastPushIndex = i;
    if (lastPushedBox !== event.boxIndex) {
      entry.phaseCount++;
      lastPushedBox = event.boxIndex;
    }
    if (i + 1 < boundaries.length) {
      const walkBefore = boundaries[i + 1].moveIndex -
        (i > 0 ? boundaries[i].moveIndex : 0) - 1;
      if (walkBefore > 0) entry.prePushWalking += walkBefore;
    }
  }
  return entries;
}

function buildScheduleTraceDiff(originalEntries, repairedEntries) {
  return originalEntries.map((original, index) => {
    const repaired = repairedEntries ? repairedEntries[index] : null;
    return {
      boxIndex: original.boxIndex,
      label: original.label,
      original: {
        pushCount: original.pushCount,
        phaseCount: original.phaseCount,
        firstPushIndex: original.firstPushIndex,
        lastPushIndex: original.lastPushIndex,
        prePushWalking: original.prePushWalking,
      },
      repaired: repaired ? {
        pushCount: repaired.pushCount,
        phaseCount: repaired.phaseCount,
        firstPushIndex: repaired.firstPushIndex,
        lastPushIndex: repaired.lastPushIndex,
        prePushWalking: repaired.prePushWalking,
      } : null,
      improvement: repaired ? {
        pushesDelta: original.pushCount - repaired.pushCount,
        phasesDelta: original.phaseCount - repaired.phaseCount,
        walkingDelta: original.prePushWalking - repaired.prePushWalking,
      } : null,
    };
  });
}
