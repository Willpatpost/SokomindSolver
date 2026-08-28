import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_EXPERIENCE_PREFERENCES,
  parseExperiencePreferences,
  resolveAppearance,
  resolveReducedMotion,
  themeColor,
  updateExperiencePreferences,
} from "../../src/features/experience/experience-preferences.ts";

test("invalid or incompatible experience preferences fail closed", () => {
  assert.equal(
    parseExperiencePreferences("not json"),
    DEFAULT_EXPERIENCE_PREFERENCES,
  );
  assert.equal(
    parseExperiencePreferences('{"version":3}'),
    DEFAULT_EXPERIENCE_PREFERENCES,
  );
  assert.equal(
    parseExperiencePreferences(null),
    DEFAULT_EXPERIENCE_PREFERENCES,
  );
});

test("fresh experience defaults enable music and effects at equal volume", () => {
  assert.equal(DEFAULT_EXPERIENCE_PREFERENCES.soundEnabled, true);
  assert.equal(DEFAULT_EXPERIENCE_PREFERENCES.musicEnabled, true);
  assert.equal(DEFAULT_EXPERIENCE_PREFERENCES.effectsVolume, 0.5);
  assert.equal(DEFAULT_EXPERIENCE_PREFERENCES.musicVolume, 0.5);
  assert.equal(DEFAULT_EXPERIENCE_PREFERENCES.themeFamily, "cozy-study");
  assert.equal(DEFAULT_EXPERIENCE_PREFERENCES.appearance, "system");
  assert.equal(DEFAULT_EXPERIENCE_PREFERENCES.zenMode, false);
});

test("version 1 preferences migrate to Cozy Study without losing appearance", () => {
  const preferences = parseExperiencePreferences(JSON.stringify({
    version: 1,
    soundEnabled: false,
    musicEnabled: true,
    effectsVolume: 0.35,
    musicVolume: 0.65,
    motion: "reduced",
    theme: "dark",
  }));

  assert.equal(preferences.version, 2);
  assert.equal(preferences.themeFamily, "cozy-study");
  assert.equal(preferences.appearance, "dark");
  assert.equal(preferences.soundEnabled, false);
  assert.equal(preferences.effectsVolume, 0.35);
  assert.equal(preferences.motion, "reduced");
  assert.equal(preferences.zenMode, false);
});

test("valid fields survive while malformed fields use safe defaults", () => {
  const preferences = parseExperiencePreferences(
    JSON.stringify({
      version: 2,
      soundEnabled: true,
      musicEnabled: true,
      effectsVolume: 2,
      musicVolume: "loud",
      motion: "unknown",
      themeFamily: "unknown",
      appearance: "sepia",
      zenMode: "yes",
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
  assert.equal(preferences.themeFamily, "cozy-study");
  assert.equal(preferences.appearance, "system");
  assert.equal(preferences.zenMode, false);
});

test("preference updates are immutable and normalize volume ranges", () => {
  const updated = updateExperiencePreferences(
    DEFAULT_EXPERIENCE_PREFERENCES,
    {
      soundEnabled: true,
      effectsVolume: -0.5,
      musicVolume: 0.55,
      motion: "reduced",
      zenMode: true,
    },
  );

  assert.notEqual(updated, DEFAULT_EXPERIENCE_PREFERENCES);
  assert.equal(DEFAULT_EXPERIENCE_PREFERENCES.soundEnabled, true);
  assert.equal(updated.soundEnabled, true);
  assert.equal(updated.effectsVolume, 0);
  assert.equal(updated.musicVolume, 0.55);
  assert.equal(updated.motion, "reduced");
  assert.equal(updated.zenMode, true);
  assert.equal(Object.isFrozen(updated), true);
});

test("motion resolution honors explicit preference before the system", () => {
  assert.equal(resolveReducedMotion("system", true), true);
  assert.equal(resolveReducedMotion("system", false), false);
  assert.equal(resolveReducedMotion("full", true), false);
  assert.equal(resolveReducedMotion("reduced", false), true);
});

test("appearance resolution and browser chrome colors cover every family", () => {
  assert.equal(resolveAppearance("system", true), "dark");
  assert.equal(resolveAppearance("system", false), "light");
  assert.equal(resolveAppearance("light", true), "light");
  assert.equal(resolveAppearance("dark", false), "dark");
  assert.equal(themeColor("cozy-study", "light"), "#f3f0e7");
  assert.equal(themeColor("midnight-neon", "dark"), "#080b18");
  assert.equal(themeColor("minimal-ink", "light"), "#f6f6f3");
});
