import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectSyncedLocation } from '../src/syncedPaths.ts';

const HOME = '/Users/silviolange';

test('the reported iCloud Drive data dir is detected', () => {
  // Verbatim shape from the round 3 report (#934).
  assert.equal(
    detectSyncedLocation(
      `${HOME}/Library/Mobile Documents/com~apple~CloudDocs/omadia`,
      HOME,
    ),
    'iCloud Drive',
  );
});

test('a macOS CloudStorage mount is detected and names its real provider', () => {
  assert.equal(
    detectSyncedLocation(`${HOME}/Library/CloudStorage/OneDrive-Personal/omadia`, HOME),
    'OneDrive',
  );
  assert.equal(
    detectSyncedLocation(`${HOME}/Library/CloudStorage/GoogleDrive-me@example.com/x`, HOME),
    'Google Drive',
  );
});

test('an unknown CloudStorage mount still warns, generically', () => {
  assert.equal(
    detectSyncedLocation(`${HOME}/Library/CloudStorage/Nextcloud-home/omadia`, HOME),
    'a cloud storage service',
  );
  assert.equal(
    detectSyncedLocation(`${HOME}/Library/CloudStorage`, HOME),
    'a cloud storage service',
  );
});

test('Dropbox, OneDrive and Google Drive under home are detected', () => {
  assert.equal(detectSyncedLocation(`${HOME}/Dropbox/omadia`, HOME), 'Dropbox');
  assert.equal(detectSyncedLocation(`${HOME}/OneDrive/omadia`, HOME), 'OneDrive');
  assert.equal(detectSyncedLocation(`${HOME}/Google Drive/omadia`, HOME), 'Google Drive');
});

test('a provider folder outside the home directory is still detected', () => {
  assert.equal(detectSyncedLocation('/Volumes/Work/OneDrive/omadia', HOME), 'OneDrive');
});

test('an ordinary local directory is not flagged', () => {
  assert.equal(detectSyncedLocation(`${HOME}/omadia-data`, HOME), null);
  assert.equal(detectSyncedLocation('/opt/omadia', HOME), null);
  assert.equal(detectSyncedLocation(`${HOME}/Library/Application Support/omadia`, HOME), null);
});

test('a name that merely contains a provider word is not flagged', () => {
  // Segment matching, not substring matching: "MyDropboxBackups" is a normal
  // local folder and warning about it would train the user to ignore warnings.
  assert.equal(detectSyncedLocation(`${HOME}/MyDropboxBackups/omadia`, HOME), null);
  assert.equal(detectSyncedLocation(`${HOME}/OneDriveArchive`, HOME), null);
});

test('the home directory itself is not flagged', () => {
  assert.equal(detectSyncedLocation(HOME, HOME), null);
});
