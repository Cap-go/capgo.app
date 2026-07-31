// test/prescan/ios-parsers.test.ts
// Unit tests for the shared iOS prescan parsing helpers. Each pure parser must
// NEVER throw — it returns null/[]/false on missing or malformed input — and is
// grounded against the real Capacitor-8 SPM tutorial project (which must stay
// false-positive clean).
import { describe, expect, it } from 'bun:test'
import {
  plistArrayStrings,
  plistBool,
  plistDictBlock,
  plistHasKey,
  plistString,
} from '../../src/build/prescan/checks/ios-plist-read'
import {
  readBuildConfigs,
  readBuildSetting,
  readTargetConfigs,
  resolvePlistValue,
} from '../../src/build/prescan/ios-pbxsettings'
import {
  entArray,
  entBool,
  entString,
  readAppEntitlements,
} from '../../src/build/prescan/ios-entitlements'
import { parseMobileprovisionDetailedFromBase64 } from '../../src/build/mobileprovision-parser'
import {
  appIconSetDir,
  hasMarketingIcon,
  readContentsJson,
} from '../../src/build/prescan/ios-appicon'
import { Buffer } from 'node:buffer'
import { join } from 'node:path'
import { makeProfileXml, makeProject } from './helpers'

// Self-contained inline fixtures mirroring the real Capacitor-8 SPM tutorial
// project's Info.plist and App.entitlements byte-for-byte (key set, $()-refs,
// orientation arrays). These keep the grounding assertions REAL on CI, where the
// external tutorial-app checkout does not exist — previously the grounding read
// absolute paths outside the repo (vacuous pass / module-load crash on CI).
const REAL_SHAPED_INFO_PLIST = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>CAPACITOR_DEBUG</key>
	<string>$(CAPACITOR_DEBUG)</string>
	<key>CFBundleDevelopmentRegion</key>
	<string>en</string>
	<key>CFBundleDisplayName</key>
	<string>Tutorial Build example app</string>
	<key>CFBundleExecutable</key>
	<string>$(EXECUTABLE_NAME)</string>
	<key>CFBundleIdentifier</key>
	<string>$(PRODUCT_BUNDLE_IDENTIFIER)</string>
	<key>CFBundleInfoDictionaryVersion</key>
	<string>6.0</string>
	<key>CFBundleName</key>
	<string>$(PRODUCT_NAME)</string>
	<key>CFBundlePackageType</key>
	<string>APPL</string>
	<key>CFBundleShortVersionString</key>
	<string>$(MARKETING_VERSION)</string>
	<key>CFBundleVersion</key>
	<string>$(CURRENT_PROJECT_VERSION)</string>
	<key>LSRequiresIPhoneOS</key>
	<true/>
	<key>UILaunchStoryboardName</key>
	<string>LaunchScreen</string>
	<key>UIMainStoryboardFile</key>
	<string>Main</string>
	<key>UIRequiredDeviceCapabilities</key>
	<array>
		<string>armv7</string>
	</array>
	<key>UISupportedInterfaceOrientations</key>
	<array>
		<string>UIInterfaceOrientationPortrait</string>
		<string>UIInterfaceOrientationLandscapeLeft</string>
		<string>UIInterfaceOrientationLandscapeRight</string>
	</array>
	<key>UISupportedInterfaceOrientations~ipad</key>
	<array>
		<string>UIInterfaceOrientationPortrait</string>
		<string>UIInterfaceOrientationPortraitUpsideDown</string>
		<string>UIInterfaceOrientationLandscapeLeft</string>
		<string>UIInterfaceOrientationLandscapeRight</string>
	</array>
	<key>UIViewControllerBasedStatusBarAppearance</key>
	<true/>
</dict>
</plist>`

// Real-shaped App.entitlements (aps-environment=development only, like the
// stock Capacitor default).
const REAL_SHAPED_ENTITLEMENTS = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>aps-environment</key>
	<string>development</string>
</dict>
</plist>`

// Real-shaped AppIcon Contents.json (single universal 1024 marketing icon).
const REAL_SHAPED_APPICON_CONTENTS = JSON.stringify({
  images: [{ idiom: 'universal', size: '1024x1024', filename: 'AppIcon-512@2x.png', platform: 'ios' }],
  info: { author: 'xcode', version: 1 },
}, null, 2)
const plist = (body: string) => `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>${body}</dict></plist>`

describe('ios-plist-read: plistString', () => {
  it('reads a top-level string value', () => {
    expect(plistString(plist('<key>CFBundleName</key><string>MyApp</string>'), 'CFBundleName')).toBe('MyApp')
  })
  it('returns null when the key is absent', () => {
    expect(plistString(plist('<key>Other</key><string>x</string>'), 'CFBundleName')).toBeNull()
  })
  it('reads an unresolved $() build-variable reference verbatim', () => {
    expect(plistString(plist('<key>CFBundleIdentifier</key><string>$(PRODUCT_BUNDLE_IDENTIFIER)</string>'), 'CFBundleIdentifier'))
      .toBe('$(PRODUCT_BUNDLE_IDENTIFIER)')
  })
  it('escapes regex metacharacters in the key (never throws)', () => {
    expect(plistString(plist('<key>a.b*c</key><string>v</string>'), 'a.b*c')).toBe('v')
  })
  it('returns null on empty/garbage input', () => {
    expect(plistString('', 'CFBundleName')).toBeNull()
    expect(plistString('<plist><<<', 'CFBundleName')).toBeNull()
  })
})

describe('ios-plist-read: plistBool', () => {
  it('reads <true/>', () => {
    expect(plistBool(plist('<key>LSRequiresIPhoneOS</key><true/>'), 'LSRequiresIPhoneOS')).toBe(true)
  })
  it('reads <false/>', () => {
    expect(plistBool(plist('<key>UIRequiresFullScreen</key><false/>'), 'UIRequiresFullScreen')).toBe(false)
  })
  it('returns null when the key is absent (distinct from false)', () => {
    expect(plistBool(plist('<key>Other</key><true/>'), 'UIRequiresFullScreen')).toBeNull()
  })
  it('returns null when the key maps to a non-bool value', () => {
    expect(plistBool(plist('<key>CFBundleName</key><string>x</string>'), 'CFBundleName')).toBeNull()
  })
})

describe('ios-plist-read: plistHasKey', () => {
  it('detects presence', () => {
    expect(plistHasKey(plist('<key>CFBundleVersion</key><string>$(X)</string>'), 'CFBundleVersion')).toBe(true)
  })
  it('returns false when absent', () => {
    expect(plistHasKey(plist('<key>CFBundleVersion</key><string>1</string>'), 'CFBundleShortVersionString')).toBe(false)
  })
})

describe('ios-plist-read: plistArrayStrings', () => {
  it('collects the <string> children of an array key', () => {
    const body = `<key>UISupportedInterfaceOrientations</key><array>
      <string>UIInterfaceOrientationPortrait</string>
      <string>UIInterfaceOrientationLandscapeLeft</string>
    </array>`
    expect(plistArrayStrings(plist(body), 'UISupportedInterfaceOrientations')).toEqual([
      'UIInterfaceOrientationPortrait',
      'UIInterfaceOrientationLandscapeLeft',
    ])
  })
  it('distinguishes the ~ipad suffixed key from the base key', () => {
    const body = `<key>UISupportedInterfaceOrientations</key><array><string>A</string></array>
      <key>UISupportedInterfaceOrientations~ipad</key><array><string>B</string><string>C</string></array>`
    expect(plistArrayStrings(plist(body), 'UISupportedInterfaceOrientations~ipad')).toEqual(['B', 'C'])
    expect(plistArrayStrings(plist(body), 'UISupportedInterfaceOrientations')).toEqual(['A'])
  })
  it('stops at the first closing tag (non-greedy)', () => {
    const body = `<key>A</key><array><string>one</string></array><key>B</key><array><string>two</string></array>`
    expect(plistArrayStrings(plist(body), 'A')).toEqual(['one'])
  })
  it('returns [] when the key is absent or not an array', () => {
    expect(plistArrayStrings(plist('<key>X</key><string>s</string>'), 'X')).toEqual([])
    expect(plistArrayStrings('', 'X')).toEqual([])
  })
})

describe('ios-plist-read: plistDictBlock', () => {
  it('returns the inner text of a one-level dict', () => {
    const body = `<key>NSAppTransportSecurity</key><dict><key>NSAllowsArbitraryLoads</key><true/></dict>`
    const inner = plistDictBlock(plist(body), 'NSAppTransportSecurity')
    expect(inner).toContain('NSAllowsArbitraryLoads')
    expect(inner).toContain('<true/>')
  })
  it('returns null when the key is absent', () => {
    expect(plistDictBlock(plist('<key>X</key><string>s</string>'), 'NSAppTransportSecurity')).toBeNull()
  })
  it('does not throw on malformed input', () => {
    expect(plistDictBlock('<dict><<<', 'X')).toBeNull()
  })
  it('returns the FULL balanced dict when a nested dict precedes a sibling key', () => {
    // NSExceptionDomains (a nested dict) appears BEFORE NSAllowsArbitraryLoads.
    // A lazy first-`</dict>` capture would truncate after NSExceptionDomains and
    // hide NSAllowsArbitraryLoads; the balanced scan must keep the sibling.
    const body = `<key>NSAppTransportSecurity</key><dict>`
      + `<key>NSExceptionDomains</key><dict><key>example.com</key><dict><key>NSIncludesSubdomains</key><true/></dict></dict>`
      + `<key>NSAllowsArbitraryLoads</key><true/>`
      + `</dict>`
    const inner = plistDictBlock(plist(body), 'NSAppTransportSecurity')
    expect(inner).not.toBeNull()
    expect(inner).toContain('NSExceptionDomains')
    expect(inner).toContain('NSAllowsArbitraryLoads')
    // The matching close wins, so the trailing sibling bool is inside the block.
    expect(plistBool(inner!, 'NSAllowsArbitraryLoads')).toBe(true)
  })
  it('returns null on an unbalanced (never-closed) dict', () => {
    expect(plistDictBlock(plist('<key>NSAppTransportSecurity</key><dict><key>A</key><dict>'), 'NSAppTransportSecurity')).toBeNull()
  })
})

describe('ios-plist-read: grounding against the real-shaped Info.plist', () => {
  const raw = REAL_SHAPED_INFO_PLIST
  it('reads the literal CFBundleDisplayName', () => {
    expect(plistString(raw, 'CFBundleDisplayName')).toBe('Tutorial Build example app')
  })
  it('reads the $() build-var refs verbatim', () => {
    expect(plistString(raw, 'CFBundleIdentifier')).toBe('$(PRODUCT_BUNDLE_IDENTIFIER)')
    expect(plistString(raw, 'CFBundleShortVersionString')).toBe('$(MARKETING_VERSION)')
    expect(plistString(raw, 'CFBundleVersion')).toBe('$(CURRENT_PROJECT_VERSION)')
    expect(plistString(raw, 'CFBundleName')).toBe('$(PRODUCT_NAME)')
  })
  it('reads LSRequiresIPhoneOS as true', () => {
    expect(plistBool(raw, 'LSRequiresIPhoneOS')).toBe(true)
  })
  it('reads UIRequiresFullScreen as null (key absent)', () => {
    expect(plistBool(raw, 'UIRequiresFullScreen')).toBeNull()
  })
  it('reads the ~ipad orientations (all four) separately from iPhone (three)', () => {
    expect(plistArrayStrings(raw, 'UISupportedInterfaceOrientations~ipad')).toEqual([
      'UIInterfaceOrientationPortrait',
      'UIInterfaceOrientationPortraitUpsideDown',
      'UIInterfaceOrientationLandscapeLeft',
      'UIInterfaceOrientationLandscapeRight',
    ])
    expect(plistArrayStrings(raw, 'UISupportedInterfaceOrientations')).toEqual([
      'UIInterfaceOrientationPortrait',
      'UIInterfaceOrientationLandscapeLeft',
      'UIInterfaceOrientationLandscapeRight',
    ])
  })
})

// Minimal pbxproj fixture: one project-level config pair + one app-target
// config pair, modelled on the Capacitor SPM layout. Release and Debug differ
// in PRODUCT_BUNDLE_IDENTIFIER so the Release-preferred lookup is observable.
const FIXTURE_PBX = `// !$*UTF8*$!
{
	objects = {
/* Begin PBXNativeTarget section */
		AAA1 /* App */ = {
			isa = PBXNativeTarget;
			buildConfigurationList = LIST_TARGET /* Build configuration list for PBXNativeTarget "App" */;
			name = App;
			productType = "com.apple.product-type.application";
		};
/* End PBXNativeTarget section */
/* Begin PBXProject section */
		PROJ /* Project object */ = {
			isa = PBXProject;
			attributes = {
				TargetAttributes = {
					AAA1 = { ProvisioningStyle = Automatic; };
				};
			};
			buildConfigurationList = LIST_PROJECT /* Build configuration list for PBXProject "App" */;
			targets = (
				AAA1 /* App */,
			);
		};
/* End PBXProject section */
/* Begin XCBuildConfiguration section */
		CFG_PROJ_DEBUG /* Debug */ = {
			isa = XCBuildConfiguration;
			buildSettings = {
				IPHONEOS_DEPLOYMENT_TARGET = 15.0;
				SDKROOT = iphoneos;
			};
			name = Debug;
		};
		CFG_PROJ_RELEASE /* Release */ = {
			isa = XCBuildConfiguration;
			buildSettings = {
				IPHONEOS_DEPLOYMENT_TARGET = 15.0;
				SDKROOT = iphoneos;
			};
			name = Release;
		};
		CFG_TGT_DEBUG /* Debug */ = {
			isa = XCBuildConfiguration;
			buildSettings = {
				CODE_SIGN_STYLE = Automatic;
				CURRENT_PROJECT_VERSION = 1;
				MARKETING_VERSION = 1.0;
				PRODUCT_BUNDLE_IDENTIFIER = com.demo.app.debug;
				PRODUCT_NAME = "Tutorial Build example app";
				TARGETED_DEVICE_FAMILY = "1,2";
			};
			name = Debug;
		};
		CFG_TGT_RELEASE /* Release */ = {
			isa = XCBuildConfiguration;
			buildSettings = {
				CODE_SIGN_STYLE = Automatic;
				CURRENT_PROJECT_VERSION = 1;
				MARKETING_VERSION = 1.0;
				PRODUCT_BUNDLE_IDENTIFIER = com.demo.app;
				PRODUCT_NAME = "Tutorial Build example app";
				TARGETED_DEVICE_FAMILY = "1,2";
			};
			name = Release;
		};
/* End XCBuildConfiguration section */
/* Begin XCConfigurationList section */
		LIST_PROJECT /* Build configuration list for PBXProject "App" */ = {
			isa = XCConfigurationList;
			buildConfigurations = (
				CFG_PROJ_DEBUG /* Debug */,
				CFG_PROJ_RELEASE /* Release */,
			);
			defaultConfigurationName = Release;
		};
		LIST_TARGET /* Build configuration list for PBXNativeTarget "App" */ = {
			isa = XCConfigurationList;
			buildConfigurations = (
				CFG_TGT_DEBUG /* Debug */,
				CFG_TGT_RELEASE /* Release */,
			);
			defaultConfigurationName = Release;
		};
/* End XCConfigurationList section */
	};
}
`

describe('ios-pbxsettings: readBuildSetting (Release-preferred scalar)', () => {
  it('prefers the Release value when configs disagree', () => {
    expect(readBuildSetting(FIXTURE_PBX, 'PRODUCT_BUNDLE_IDENTIFIER')).toBe('com.demo.app')
  })
  it('strips surrounding quotes from a quoted value', () => {
    expect(readBuildSetting(FIXTURE_PBX, 'PRODUCT_NAME')).toBe('Tutorial Build example app')
    expect(readBuildSetting(FIXTURE_PBX, 'TARGETED_DEVICE_FAMILY')).toBe('1,2')
  })
  it('reads an unquoted scalar present in every config', () => {
    expect(readBuildSetting(FIXTURE_PBX, 'IPHONEOS_DEPLOYMENT_TARGET')).toBe('15.0')
  })
  it('returns null for an absent / inherited key', () => {
    expect(readBuildSetting(FIXTURE_PBX, 'ENABLE_BITCODE')).toBeNull()
  })
  it('does not throw on empty input', () => {
    expect(readBuildSetting('', 'IPHONEOS_DEPLOYMENT_TARGET')).toBeNull()
  })
})

describe('ios-pbxsettings: resolvePlistValue ($()->pbxproj substitution)', () => {
  it('substitutes a $(VAR) reference from the pbxproj', () => {
    expect(resolvePlistValue('$(PRODUCT_BUNDLE_IDENTIFIER)', FIXTURE_PBX)).toBe('com.demo.app')
  })
  it('substitutes the ${VAR} brace form too', () => {
    expect(resolvePlistValue('${MARKETING_VERSION}', FIXTURE_PBX)).toBe('1.0')
  })
  it('returns a literal value unchanged', () => {
    expect(resolvePlistValue('1.4.2', FIXTURE_PBX)).toBe('1.4.2')
    expect(resolvePlistValue('Tutorial Build example app', FIXTURE_PBX)).toBe('Tutorial Build example app')
  })
  it('returns the raw $() string when the var has no pbxproj match (caller treats as skip)', () => {
    expect(resolvePlistValue('$(CAPACITOR_DEBUG)', FIXTURE_PBX)).toBe('$(CAPACITOR_DEBUG)')
  })
  it('does not substitute a value that merely contains a $() among other text', () => {
    expect(resolvePlistValue('prefix-$(MARKETING_VERSION)', FIXTURE_PBX)).toBe('prefix-$(MARKETING_VERSION)')
  })
  it('does not resolve malformed references with mismatched delimiters', () => {
    expect(resolvePlistValue('$(MARKETING_VERSION}', FIXTURE_PBX)).toBe('$(MARKETING_VERSION}')
    expect(resolvePlistValue('${MARKETING_VERSION)', FIXTURE_PBX)).toBe('${MARKETING_VERSION)')
  })
})

describe('ios-pbxsettings: readBuildConfigs', () => {
  it('returns all four configs with project-level flagged', () => {
    const configs = readBuildConfigs(FIXTURE_PBX)
    expect(configs.length).toBe(4)
    const projectLevel = configs.filter(c => c.isProjectLevel)
    expect(projectLevel.length).toBe(2)
    expect(projectLevel.every(c => c.settings.IPHONEOS_DEPLOYMENT_TARGET === '15.0')).toBe(true)
    const targetLevel = configs.filter(c => !c.isProjectLevel)
    expect(targetLevel.some(c => c.name === 'Release' && c.settings.PRODUCT_BUNDLE_IDENTIFIER === 'com.demo.app')).toBe(true)
  })
  it('captures scalar settings only and strips quotes', () => {
    const release = readBuildConfigs(FIXTURE_PBX).find(c => !c.isProjectLevel && c.name === 'Release')!
    expect(release.settings.PRODUCT_NAME).toBe('Tutorial Build example app')
    expect(release.settings.CODE_SIGN_STYLE).toBe('Automatic')
  })
  it('returns [] on empty input', () => {
    expect(readBuildConfigs('')).toEqual([])
  })
})

describe('ios-pbxsettings: readTargetConfigs', () => {
  it('returns per-target per-config settings for the signable App target', () => {
    const targets = readTargetConfigs(FIXTURE_PBX)
    expect(targets.length).toBe(1)
    const app = targets[0]
    expect(app.target.name).toBe('App')
    const names = app.configs.map(c => c.name).sort()
    expect(names).toEqual(['Debug', 'Release'])
    const rel = app.configs.find(c => c.name === 'Release')!
    expect(rel.settings.PRODUCT_BUNDLE_IDENTIFIER).toBe('com.demo.app')
    const dbg = app.configs.find(c => c.name === 'Debug')!
    expect(dbg.settings.PRODUCT_BUNDLE_IDENTIFIER).toBe('com.demo.app.debug')
  })
  it('returns [] on empty input', () => {
    expect(readTargetConfigs('')).toEqual([])
  })
})

// Real-shaped pbxproj mirroring the tutorial-app's distinctive build settings
// (real bundle id, AppIcon name, version pair, Cap8 deployment target) so the
// grounding assertions below are self-contained and REAL on CI.
const REAL_SHAPED_PBX = `// !$*UTF8*$!
{
\tobjects = {
/* Begin PBXNativeTarget section */
\t\tAAA1 /* App */ = {
\t\t\tisa = PBXNativeTarget;
\t\t\tbuildConfigurationList = LIST_TARGET /* Build configuration list for PBXNativeTarget "App" */;
\t\t\tname = App;
\t\t\tproductType = "com.apple.product-type.application";
\t\t};
/* End PBXNativeTarget section */
/* Begin PBXProject section */
\t\tPROJ /* Project object */ = {
\t\t\tisa = PBXProject;
\t\t\tattributes = {
\t\t\t\tTargetAttributes = {
\t\t\t\t\tAAA1 = { ProvisioningStyle = Automatic; };
\t\t\t\t};
\t\t\t};
\t\t\tbuildConfigurationList = LIST_PROJECT /* Build configuration list for PBXProject "App" */;
\t\t\ttargets = (
\t\t\t\tAAA1 /* App */,
\t\t\t);
\t\t};
/* End PBXProject section */
/* Begin XCBuildConfiguration section */
\t\tCFG_PROJ_DEBUG /* Debug */ = {
\t\t\tisa = XCBuildConfiguration;
\t\t\tbuildSettings = {
\t\t\t\tIPHONEOS_DEPLOYMENT_TARGET = 15.0;
\t\t\t\tSDKROOT = iphoneos;
\t\t\t};
\t\t\tname = Debug;
\t\t};
\t\tCFG_PROJ_RELEASE /* Release */ = {
\t\t\tisa = XCBuildConfiguration;
\t\t\tbuildSettings = {
\t\t\t\tIPHONEOS_DEPLOYMENT_TARGET = 15.0;
\t\t\t\tSDKROOT = iphoneos;
\t\t\t};
\t\t\tname = Release;
\t\t};
\t\tCFG_TGT_DEBUG /* Debug */ = {
\t\t\tisa = XCBuildConfiguration;
\t\t\tbuildSettings = {
\t\t\t\tASSETCATALOG_COMPILER_APPICON_NAME = AppIcon;
\t\t\t\tCODE_SIGN_STYLE = Automatic;
\t\t\t\tCURRENT_PROJECT_VERSION = 1;
\t\t\t\tMARKETING_VERSION = 1.0;
\t\t\t\tPRODUCT_BUNDLE_IDENTIFIER = app.capgo.plugin.TutorialBuild;
\t\t\t\tPRODUCT_NAME = "Tutorial Build example app";
\t\t\t\tTARGETED_DEVICE_FAMILY = "1,2";
\t\t\t};
\t\t\tname = Debug;
\t\t};
\t\tCFG_TGT_RELEASE /* Release */ = {
\t\t\tisa = XCBuildConfiguration;
\t\t\tbuildSettings = {
\t\t\t\tASSETCATALOG_COMPILER_APPICON_NAME = AppIcon;
\t\t\t\tCODE_SIGN_STYLE = Automatic;
\t\t\t\tCURRENT_PROJECT_VERSION = 1;
\t\t\t\tMARKETING_VERSION = 1.0;
\t\t\t\tPRODUCT_BUNDLE_IDENTIFIER = app.capgo.plugin.TutorialBuild;
\t\t\t\tPRODUCT_NAME = "Tutorial Build example app";
\t\t\t\tTARGETED_DEVICE_FAMILY = "1,2";
\t\t\t};
\t\t\tname = Release;
\t\t};
/* End XCBuildConfiguration section */
/* Begin XCConfigurationList section */
\t\tLIST_PROJECT /* Build configuration list for PBXProject "App" */ = {
\t\t\tisa = XCConfigurationList;
\t\t\tbuildConfigurations = (
\t\t\t\tCFG_PROJ_DEBUG /* Debug */,
\t\t\t\tCFG_PROJ_RELEASE /* Release */,
\t\t\t);
\t\t\tdefaultConfigurationName = Release;
\t\t};
\t\tLIST_TARGET /* Build configuration list for PBXNativeTarget "App" */ = {
\t\t\tisa = XCConfigurationList;
\t\t\tbuildConfigurations = (
\t\t\t\tCFG_TGT_DEBUG /* Debug */,
\t\t\t\tCFG_TGT_RELEASE /* Release */,
\t\t\t);
\t\t\tdefaultConfigurationName = Release;
\t\t};
/* End XCConfigurationList section */
\t};
}
`

describe('ios-pbxsettings: grounding against the real-shaped pbxproj', () => {
  const pbx = REAL_SHAPED_PBX
  it('reads the grounding scalar build settings (Release-preferred)', () => {
    expect(readBuildSetting(pbx, 'IPHONEOS_DEPLOYMENT_TARGET')).toBe('15.0')
    expect(readBuildSetting(pbx, 'PRODUCT_BUNDLE_IDENTIFIER')).toBe('app.capgo.plugin.TutorialBuild')
    expect(readBuildSetting(pbx, 'ASSETCATALOG_COMPILER_APPICON_NAME')).toBe('AppIcon')
    expect(readBuildSetting(pbx, 'MARKETING_VERSION')).toBe('1.0')
    expect(readBuildSetting(pbx, 'CURRENT_PROJECT_VERSION')).toBe('1')
    expect(readBuildSetting(pbx, 'TARGETED_DEVICE_FAMILY')).toBe('1,2')
  })
  it('returns null for ENABLE_BITCODE (absent in the grounding project)', () => {
    expect(readBuildSetting(pbx, 'ENABLE_BITCODE')).toBeNull()
  })
  it('resolves the real Info.plist $() refs against the real pbxproj', () => {
    const info = REAL_SHAPED_INFO_PLIST
    expect(resolvePlistValue(plistString(info, 'CFBundleIdentifier')!, pbx)).toBe('app.capgo.plugin.TutorialBuild')
    expect(resolvePlistValue(plistString(info, 'CFBundleShortVersionString')!, pbx)).toBe('1.0')
    expect(resolvePlistValue(plistString(info, 'CFBundleVersion')!, pbx)).toBe('1')
    expect(resolvePlistValue(plistString(info, 'CFBundleName')!, pbx)).toBe('Tutorial Build example app')
  })
  it('leaves CAPACITOR_DEBUG unresolved (no pbxproj setting -> skip)', () => {
    const info = REAL_SHAPED_INFO_PLIST
    expect(resolvePlistValue(plistString(info, 'CAPACITOR_DEBUG')!, pbx)).toBe('$(CAPACITOR_DEBUG)')
  })
  it('finds the single signable App target with Debug+Release configs', () => {
    const targets = readTargetConfigs(pbx)
    expect(targets.length).toBe(1)
    expect(targets[0].target.name).toBe('App')
    expect(targets[0].configs.map(c => c.name).sort()).toEqual(['Debug', 'Release'])
  })
})

// A temp project dir populated with the real-shaped fixtures, standing in for
// the external tutorial-app checkout so the on-disk grounding tests (entitlements
// reader, appicon Contents.json) are self-contained and REAL on CI.
const REAL_PROJECT_DIR = makeProject({
  'ios/App/App/App.entitlements': REAL_SHAPED_ENTITLEMENTS,
  'ios/App/App/Info.plist': REAL_SHAPED_INFO_PLIST,
  'ios/App/App.xcodeproj/project.pbxproj': REAL_SHAPED_PBX,
  'ios/App/App/Assets.xcassets/AppIcon.appiconset/Contents.json': REAL_SHAPED_APPICON_CONTENTS,
})

const entitlements = (body: string) => `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>${body}</dict></plist>`

describe('ios-entitlements: readAppEntitlements', () => {
  it('reads ios/App/App/App.entitlements when present', () => {
    const dir = makeProject({ 'ios/App/App/App.entitlements': entitlements('<key>aps-environment</key><string>development</string>') })
    const ent = readAppEntitlements(dir)
    expect(ent).not.toBeNull()
    expect(ent!.raw).toContain('aps-environment')
  })
  it('returns null when the entitlements file is absent', () => {
    expect(readAppEntitlements(makeProject({}))).toBeNull()
  })
  it('reads the app target CODE_SIGN_ENTITLEMENTS path before the Capacitor default', () => {
    const custom = entitlements('<key>com.apple.developer.healthkit</key><true/>')
    const pbx = FIXTURE_PBX.replace(
      'CODE_SIGN_STYLE = Automatic;',
      'CODE_SIGN_STYLE = Automatic;\n\t\t\t\tCODE_SIGN_ENTITLEMENTS = Config/Custom.entitlements;',
    )
    const dir = makeProject({
      'ios/App/App.xcodeproj/project.pbxproj': pbx,
      'ios/App/Config/Custom.entitlements': custom,
      'ios/App/App/App.entitlements': entitlements('<key>aps-environment</key><string>development</string>'),
    })
    const app = readAppEntitlements(dir, 'com.demo.app')
    expect(app?.raw).toBe(custom)
  })
  it('reads the typed accessors off the raw text', () => {
    const raw = entitlements(`
      <key>aps-environment</key><string>development</string>
      <key>com.apple.security.application-groups</key><array><string>group.com.demo.app</string></array>
      <key>com.apple.developer.healthkit</key><true/>`)
    expect(entString(raw, 'aps-environment')).toBe('development')
    expect(entArray(raw, 'com.apple.security.application-groups')).toEqual(['group.com.demo.app'])
    expect(entBool(raw, 'com.apple.developer.healthkit')).toBe(true)
    expect(entBool(raw, 'get-task-allow')).toBeNull()
    expect(entArray(raw, 'keychain-access-groups')).toEqual([])
  })
  it('grounds clean against the real App.entitlements (aps-environment=development only)', () => {
    const ent = readAppEntitlements(REAL_PROJECT_DIR)
    expect(ent).not.toBeNull()
    expect(entString(ent!.raw, 'aps-environment')).toBe('development')
    expect(entArray(ent!.raw, 'com.apple.security.application-groups')).toEqual([])
  })
})

describe('mobileprovision-parser: profileEntitlements', () => {
  function detailFromXml(xml: string) {
    const buf = Buffer.concat([Buffer.from([0x30, 0x82, 0x00, 0x00]), Buffer.from(xml, 'utf8')])
    return parseMobileprovisionDetailedFromBase64(buf.toString('base64'))
  }

  it('parses string, array and bool capability keys (not application-identifier)', () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
<key>Name</key><string>Test</string>
<key>UUID</key><string>u</string>
<key>TeamIdentifier</key><array><string>TEAM123456</string></array>
<key>Entitlements</key><dict>
  <key>application-identifier</key><string>TEAM123456.com.demo.app</string>
  <key>aps-environment</key><string>production</string>
  <key>com.apple.security.application-groups</key><array><string>group.com.demo.app</string><string>group.com.demo.shared</string></array>
  <key>com.apple.developer.associated-domains</key><array><string>applinks:demo.com</string></array>
  <key>com.apple.developer.healthkit</key><true/>
  <key>get-task-allow</key><false/>
</dict>
</dict></plist>`
    const ent = detailFromXml(xml).profileEntitlements
    expect(ent['aps-environment']).toBe('production')
    expect(ent['com.apple.security.application-groups']).toEqual(['group.com.demo.app', 'group.com.demo.shared'])
    expect(ent['com.apple.developer.associated-domains']).toEqual(['applinks:demo.com'])
    expect(ent['com.apple.developer.healthkit']).toBe(true)
    expect(ent['get-task-allow']).toBe(false)
    // application-identifier is auto-managed and intentionally NOT surfaced.
    expect('application-identifier' in ent).toBe(false)
  })

  it('surfaces capability keys outside the legacy allowlist (App Attest, Sign in with Apple, Siri)', () => {
    // Regression: the profile side must scan ALL entitlement keys generically, the
    // same way the app side does. Previously only a fixed ~10-key allowlist was read,
    // so any granted-but-non-allowlisted capability looked "missing" and produced a
    // false-positive blocking error in entitlements-vs-profile-capability.
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
<key>Name</key><string>Test</string>
<key>UUID</key><string>u</string>
<key>TeamIdentifier</key><array><string>TEAM123456</string></array>
<key>Entitlements</key><dict>
  <key>application-identifier</key><string>TEAM123456.com.demo.app</string>
  <key>com.apple.developer.devicecheck.appattest-environment</key><string>production</string>
  <key>com.apple.developer.siri</key><true/>
  <key>com.apple.developer.applesignin</key><array><string>Default</string></array>
</dict>
</dict></plist>`
    const ent = detailFromXml(xml).profileEntitlements
    expect(ent['com.apple.developer.devicecheck.appattest-environment']).toBe('production')
    expect(ent['com.apple.developer.siri']).toBe(true)
    expect(ent['com.apple.developer.applesignin']).toEqual(['Default'])
    // auto-managed keys stay hidden even with generic scanning.
    expect('application-identifier' in ent).toBe(false)
  })

  it('omits capability keys that are absent (missing != false)', () => {
    const ent = detailFromXml(makeProfileXml({ type: 'app_store' })).profileEntitlements
    expect('com.apple.security.application-groups' in ent).toBe(false)
    expect('aps-environment' in ent).toBe(false)
    expect('get-task-allow' in ent).toBe(false)
  })

  it('returns {} when there is no Entitlements dict (never throws)', () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
<key>Name</key><string>Test</string>
<key>UUID</key><string>u</string>
</dict></plist>`
    expect(detailFromXml(xml).profileEntitlements).toEqual({})
  })

  it('keeps the existing detail fields intact (no regression)', () => {
    const detail = detailFromXml(makeProfileXml({ type: 'app_store', teamId: 'TEAM999999', bundleId: 'com.demo.app' }))
    expect(detail.teamId).toBe('TEAM999999')
    expect(detail.bundleId).toBe('com.demo.app')
    expect(detail.profileType).toBe('app_store')
    expect(detail.profileEntitlements).toEqual({})
  })
})

const APPICON_REL = 'ios/App/App/Assets.xcassets/AppIcon.appiconset'
const CONTENTS_REL = `${APPICON_REL}/Contents.json`

describe('ios-appicon: readContentsJson', () => {
  it('parses a valid Contents.json', () => {
    const dir = makeProject({ [CONTENTS_REL]: JSON.stringify({ images: [{ size: '1024x1024', filename: 'icon.png' }] }) })
    const c = readContentsJson(join(dir, CONTENTS_REL))
    expect(c?.images?.length).toBe(1)
    expect(c?.images?.[0].filename).toBe('icon.png')
  })
  it('returns null on a missing file (never throws)', () => {
    expect(readContentsJson('/no/such/Contents.json')).toBeNull()
  })
  it('returns null on malformed JSON (never throws)', () => {
    const dir = makeProject({ [CONTENTS_REL]: '{ not: json,,, ' })
    expect(readContentsJson(join(dir, CONTENTS_REL))).toBeNull()
  })
})

describe('ios-appicon: appIconSetDir', () => {
  it('defaults to AppIcon when no pbxproj icon name is given', () => {
    const dir = makeProject({})
    expect(appIconSetDir(dir)).toBe(join(dir, 'ios', 'App', 'App', 'Assets.xcassets', 'AppIcon.appiconset'))
  })
  it('honours ASSETCATALOG_COMPILER_APPICON_NAME from the pbxproj', () => {
    const dir = makeProject({})
    const pbx = [
      'CFG /* Release */ = {',
      '\tisa = XCBuildConfiguration;',
      '\tbuildSettings = {',
      '\t\tASSETCATALOG_COMPILER_APPICON_NAME = BrandIcon;',
      '\t};',
      '\tname = Release;',
      '};',
    ].join('\n')
    expect(appIconSetDir(dir, pbx)).toBe(join(dir, 'ios', 'App', 'App', 'Assets.xcassets', 'BrandIcon.appiconset'))
  })
})

describe('ios-appicon: hasMarketingIcon', () => {
  it('true when a 1024x1024 image is present', () => {
    expect(hasMarketingIcon({ images: [{ size: '1024x1024', filename: 'icon.png' }] })).toBe(true)
  })
  it('trims whitespace around the size before comparing', () => {
    expect(hasMarketingIcon({ images: [{ size: ' 1024x1024 ', filename: 'icon.png' }] })).toBe(true)
  })
  it('true when an image has role marketing', () => {
    expect(hasMarketingIcon({ images: [{ role: 'marketing', filename: 'icon.png' }] })).toBe(true)
  })
  it('false when only smaller icons are present', () => {
    expect(hasMarketingIcon({ images: [{ size: '60x60', scale: '2x', filename: 'i.png' }] })).toBe(false)
  })
  it('false on null/empty contents (never throws)', () => {
    expect(hasMarketingIcon(null)).toBe(false)
    expect(hasMarketingIcon({})).toBe(false)
    expect(hasMarketingIcon({ images: [] })).toBe(false)
  })
})

describe('ios-appicon: grounding against the real AppIcon.appiconset', () => {
  const realContents = join(REAL_PROJECT_DIR, CONTENTS_REL)
  it('parses the real single-universal-1024 Contents.json', () => {
    const c = readContentsJson(realContents)
    expect(c?.images?.length).toBe(1)
    expect(c?.images?.[0].size).toBe('1024x1024')
    expect(c?.images?.[0].filename).toBe('AppIcon-512@2x.png')
  })
  it('has the marketing (1024) icon', () => {
    expect(hasMarketingIcon(readContentsJson(realContents))).toBe(true)
  })
  it('resolves the real appicon dir from the pbxproj AppIcon name', () => {
    const pbx = REAL_SHAPED_PBX
    expect(appIconSetDir(REAL_PROJECT_DIR, pbx)).toBe(join(REAL_PROJECT_DIR, 'ios', 'App', 'App', 'Assets.xcassets', 'AppIcon.appiconset'))
  })
})
