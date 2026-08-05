import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_EXPERIENCE_PREFERENCES,
  parseExperiencePreferences,
  resolveReducedMotion,
  updateExperiencePreferences,
} from "../../src/features/experience/experience-preferences.ts";

test("invalid or incompatible experience preferences fail closed", () => {
  assert.equal(
    parseExperiencePreferences("not json"),
    DEFAULT_EXPERIENCE_PREFERENCES,
  );
  assert.equal(
    parseExperiencePreferences('{"version":2}'),
    DEFAULT_EXPERIENCE_PREFERENCES,
  );
  assert.equal(
    parseExperiencePreferences(null),
    DEFAULT_EXPERIENCE_PREFERENCES,
  );
});

test("valid fields survive while malformed fields use safe defaults", () => {
  const preferences = parseExperiencePreferences(
    JSON.stringify({
      version: 1,
      soundEnabled: true,
      musicEnabled: true,
      effectsVolume: 2,
      musicVolume: "loud",
      motion: "unknown",
    }),
  );

  assert.equal(preferences.soundEnabled, true);
  assert.equal(preferences.musicEnabled, true);
  assert.equal(preferences.effectsVolume, 1);
  assert.equal(
    preferences.musicVolume,
    DEFAULT_EXPERIENCE_PREFERENCES.musicVolume,
  );
  assert.equal(preferences.motion, "system");
});

test("preference updates are immutable and normalize volume ranges", () => {
  const updated = updateExperiencePreferences(
    DEFAULT_EXPERIENCE_PREFERENCES,
    {
      soundEnabled: true,
      effectsVolume: -0.5,
      musicVolume: 0.55,
      motion: "reduced",
    },
  );

  assert.notEqual(updated, DEFAULT_EXPERIENCE_PREFERENCES);
  assert.equal(DEFAULT_EXPERIENCE_PREFERENCES.soundEnabled, false);
  assert.equal(updated.soundEnabled, true);
  assert.equal(updated.effectsVolume, 0);
  assert.equal(updated.musicVolume, 0.55);
  assert.equal(updated.motion, "reduced");
  assert.equal(Object.isFrozen(updated), true);
});

test("motion resolution honors explicit preference before the system", () => {
  assert.equal(resolveReducedMotion("system", true), true);
  assert.equal(resolveReducedMotion("system", false), false);
  assert.equal(resolveReducedMotion("full", true), false);
  assert.equal(resolveReducedMotion("reduced", false), true);
});
