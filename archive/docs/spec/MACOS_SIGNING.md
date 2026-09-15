# macOS signing and notarization

The project distributes DMGs through GitHub Releases, so it uses a `Developer ID Application` certificate rather than the `Apple Distribution` certificate used for the Mac App Store. The release workflow applies a Hardened Runtime signature, submits the app to Apple for notarization, staples the ticket, and verifies the result again with `codesign`, `stapler`, and Gatekeeper after the build.

## Prepare the certificate

An active Apple Developer Program membership is required. Only the team's Account Holder can create a `Developer ID Application` certificate.

1. In Keychain Access on macOS, open Certificate Assistant → Request a Certificate From a Certificate Authority, generate a CSR, and save it to disk.
2. Open [Certificates, Identifiers & Profiles](https://developer.apple.com/account/resources/certificates/list), create a `Developer ID Application` certificate, and upload the CSR.
3. Download the `.cer` file and double-click it to install it in the `login` keychain.
4. Under My Certificates, expand the certificate and confirm that its private key is present.
5. Run the following command. Its output should include `Developer ID Application: ... (TEAM_ID)`:

```bash
security find-identity -v -p codesigning
```

From Keychain Access → My Certificates, export the certificate together with its private key as a password-protected `.p12` file. Never commit the CSR private key, `.p12`, password, or the encoded text produced below.

## Configure GitHub Actions secrets

Convert the `.p12` file to single-line Base64 and copy it to the clipboard:

```bash
openssl base64 -A -in /path/to/DeveloperIDApplication.p12 | pbcopy
```

In the GitHub repository, open Settings → Secrets and variables → Actions and add these repository secrets:

| Secret | Value |
| --- | --- |
| `APPLE_CERTIFICATE` | Base64 text for the `.p12` from the clipboard |
| `APPLE_CERTIFICATE_PASSWORD` | Password selected when exporting the `.p12` |
| `APPLE_ID` | Apple Developer account email address |
| `APPLE_PASSWORD` | An app-specific password created at [Apple Account](https://account.apple.com/), not the account login password |
| `APPLE_TEAM_ID` | Team ID from [Membership details](https://developer.apple.com/account/#/membership/) |

`TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` sign Tauri updater artifacts. They are separate from Apple code signing and must remain configured.

The current Tauri 2 bundler creates a temporary keychain from `APPLE_CERTIFICATE`, imports the certificate, and removes the keychain afterward, so no separate `KEYCHAIN_PASSWORD` secret is required. The workflow only passes Apple credentials to macOS builds and fails before packaging when any required secret is absent.

## Verify locally

After installing the certificate in the local keychain, set the notarization credentials for the current terminal and build. `APPLE_PASSWORD` must be an app-specific password:

```bash
export APPLE_SIGNING_IDENTITY='Developer ID Application: Your Name (TEAM_ID)'
export APPLE_ID='your-apple-id@example.com'
export APPLE_PASSWORD='xxxx-xxxx-xxxx-xxxx'
export APPLE_TEAM_ID='TEAM_ID'
pnpm tauri build --bundles app,dmg
```

Verify the `.app` after the build. Requesting both `app,dmg` keeps the app available for inspection; Tauri notarizes and staples it before creating the DMG:

```bash
APP_PATH='src-tauri/target/release/bundle/macos/Deepseek Harness Desktop.app'
codesign --verify --deep --strict --verbose=2 "$APP_PATH"
xcrun stapler validate "$APP_PATH"
spctl --assess --type execute --verbose=4 "$APP_PATH"
```

Close the terminal when finished to clear the sensitive environment variables. Do not put these exports in repository files or shell startup files.

## Release

Pushing a `v*` tag builds separate signed and notarized DMGs for Intel and Apple Silicon. To test first, manually run `Build & Release` from Actions and select one macOS architecture; manual builds use the same signing, notarization, and verification path.
