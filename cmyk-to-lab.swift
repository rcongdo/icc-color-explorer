import Foundation
import ColorSync

struct Payload: Decodable {
    let mode: String?
    let L: Double?
    let a: Double?
    let b: Double?
    let c: Double?
    let m: Double?
    let y: Double?
    let k: Double?
    let profilePath: String
    let intent: String?
}

func fail(_ message: String) -> Never {
    FileHandle.standardError.write(Data(message.utf8))
    exit(1)
}

func clamp(_ value: Double, _ minValue: Double, _ maxValue: Double) -> Double {
    min(maxValue, max(minValue, value))
}

func clamp01(_ value: Double) -> Double {
    min(1, max(0, value))
}

let data = FileHandle.standardInput.readDataToEndOfFile()
let payload: Payload
do {
    payload = try JSONDecoder().decode(Payload.self, from: data)
} catch {
    fail("Invalid request JSON")
}

let sourceURL = URL(fileURLWithPath: payload.profilePath)
guard FileManager.default.fileExists(atPath: sourceURL.path) else {
    fail("ICC profile not found")
}

guard let cmykProfile = ColorSyncProfileCreateWithURL(sourceURL as CFURL, nil)?.takeRetainedValue() else {
    fail("Could not load CMYK ICC profile")
}

let labURL = URL(fileURLWithPath: "/System/Library/ColorSync/Profiles/Generic Lab Profile.icc")
guard let labProfile = ColorSyncProfileCreateWithURL(labURL as CFURL, nil)?.takeRetainedValue() else {
    fail("Could not load Generic Lab Profile")
}

let intentValue: CFString
switch payload.intent ?? "relative" {
case "perceptual":
    intentValue = kColorSyncRenderingIntentPerceptual.takeUnretainedValue()
case "saturation":
    intentValue = kColorSyncRenderingIntentSaturation.takeUnretainedValue()
case "absolute":
    intentValue = kColorSyncRenderingIntentAbsolute.takeUnretainedValue()
default:
    intentValue = kColorSyncRenderingIntentRelative.takeUnretainedValue()
}

let profileKey = kColorSyncProfile.takeUnretainedValue() as String
let intentKey = kColorSyncRenderingIntent.takeUnretainedValue() as String
let tagKey = kColorSyncTransformTag.takeUnretainedValue() as String
let qualityOptions = [
    kColorSyncConvertQuality.takeUnretainedValue() as String: kColorSyncBestQuality.takeUnretainedValue()
] as CFDictionary

func profileStep(_ profile: ColorSyncProfile, _ tag: CFString) -> [String: Any] {
    return [
        profileKey: profile,
        intentKey: intentValue,
        tagKey: tag
    ]
}

func makeTransform(_ steps: [[String: Any]]) -> ColorSyncTransform? {
    ColorSyncTransformCreate(steps as CFArray, qualityOptions)?.takeRetainedValue()
}

func convert(_ transform: ColorSyncTransform, source: [Float32], outputChannels: Int) -> [Float32]? {
    var src = source
    var dst = Array(repeating: Float32(0), count: outputChannels)
    let ok = ColorSyncTransformConvert(
        transform,
        1,
        1,
        &dst,
        kColorSync32BitFloat,
        ColorSyncDataLayout(kColorSyncAlphaNone.rawValue),
        MemoryLayout<Float32>.size * outputChannels,
        &src,
        kColorSync32BitFloat,
        ColorSyncDataLayout(kColorSyncAlphaNone.rawValue),
        MemoryLayout<Float32>.size * source.count,
        nil
    )
    return ok ? dst : nil
}

func encodeLab(L: Double, a: Double, b: Double) -> [Float32] {
    return [
        Float32(clamp(L, 0, 100) / 100.0),
        Float32((clamp(a, -128, 127) + 128.0) / 255.0),
        Float32((clamp(b, -128, 127) + 128.0) / 255.0)
    ]
}

func encodeCmyk(c: Double, m: Double, y: Double, k: Double) -> [Float32] {
    return [
        Float32(clamp(c, 0, 100) / 100.0),
        Float32(clamp(m, 0, 100) / 100.0),
        Float32(clamp(y, 0, 100) / 100.0),
        Float32(clamp(k, 0, 100) / 100.0)
    ]
}

func decodeLab(_ encoded: [Float32]) -> [String: Double] {
    [
        "L": Double(encoded[0] * 100.0),
        "a": Double(encoded[1] * 255.0 - 128.0),
        "b": Double(encoded[2] * 255.0 - 128.0)
    ]
}

func labToSrgb(L: Double, a: Double, b: Double) -> [String: Int] {
    let fy = (L + 16.0) / 116.0
    let fx = fy + a / 500.0
    let fz = fy - b / 200.0
    let epsilon = 216.0 / 24389.0
    let kappa = 24389.0 / 27.0

    func pivot(_ value: Double) -> Double {
        let cubed = value * value * value
        return cubed > epsilon ? cubed : (116.0 * value - 16.0) / kappa
    }

    // Lab is D50-referenced. Convert D50 XYZ to D65 XYZ for sRGB display.
    let xD50 = 0.96422 * pivot(fx)
    let yD50 = 1.00000 * pivot(fy)
    let zD50 = 0.82521 * pivot(fz)

    let xD65 = 0.9555766 * xD50 - 0.0230393 * yD50 + 0.0631636 * zD50
    let yD65 = -0.0282895 * xD50 + 1.0099416 * yD50 + 0.0210077 * zD50
    let zD65 = 0.0122982 * xD50 - 0.0204830 * yD50 + 1.3299098 * zD50

    let linearR = 3.2404542 * xD65 - 1.5371385 * yD65 - 0.4985314 * zD65
    let linearG = -0.9692660 * xD65 + 1.8760108 * yD65 + 0.0415560 * zD65
    let linearB = 0.0556434 * xD65 - 0.2040259 * yD65 + 1.0572252 * zD65

    func encodeSrgb(_ value: Double) -> Int {
        let channel = clamp01(value)
        let encoded = channel <= 0.0031308 ? 12.92 * channel : 1.055 * pow(channel, 1.0 / 2.4) - 0.055
        return Int(round(clamp01(encoded) * 255.0))
    }

    return [
        "r": encodeSrgb(linearR),
        "g": encodeSrgb(linearG),
        "b": encodeSrgb(linearB)
    ]
}

let labToCmykSteps = [
    profileStep(cmykProfile, kColorSyncTransformPCSToDevice.takeUnretainedValue())
]
let cmykToLabSteps = [
    profileStep(cmykProfile, kColorSyncTransformDeviceToPCS.takeUnretainedValue()),
    profileStep(labProfile, kColorSyncTransformPCSToDevice.takeUnretainedValue())
]
guard let labToCmyk = makeTransform(labToCmykSteps),
      let cmykToLab = makeTransform(cmykToLabSteps) else {
    fail("Could not create ColorSync transform for this profile")
}

let mode = payload.mode ?? "lab"
let cmyk: [Float32]
let inputLab: [String: Double]
let outputLab: [String: Double]

if mode == "cmyk" {
    cmyk = encodeCmyk(
        c: payload.c ?? 0,
        m: payload.m ?? 0,
        y: payload.y ?? 0,
        k: payload.k ?? 0
    )

    guard let profileLabEncoded = convert(cmykToLab, source: cmyk, outputChannels: 3) else {
        fail("ColorSync conversion failed for this profile")
    }
    outputLab = decodeLab(profileLabEncoded)
    inputLab = outputLab
} else {
    let encodedInputLab = encodeLab(
        L: payload.L ?? 55,
        a: payload.a ?? 0,
        b: payload.b ?? 0
    )

    guard let convertedCmyk = convert(labToCmyk, source: encodedInputLab, outputChannels: 4),
          let outputLabEncoded = convert(cmykToLab, source: convertedCmyk, outputChannels: 3) else {
        fail("ColorSync conversion failed for this profile")
    }
    cmyk = convertedCmyk
    inputLab = [
        "L": clamp(payload.L ?? 55, 0, 100),
        "a": clamp(payload.a ?? 0, -128, 127),
        "b": clamp(payload.b ?? 0, -128, 127)
    ]
    outputLab = decodeLab(outputLabEncoded)
}

let inputRgb = labToSrgb(L: inputLab["L"] ?? 0, a: inputLab["a"] ?? 0, b: inputLab["b"] ?? 0)
let outputRgb = labToSrgb(L: outputLab["L"] ?? 0, a: outputLab["a"] ?? 0, b: outputLab["b"] ?? 0)

let result: [String: Any] = [
    "mode": mode,
    "inputLab": inputLab,
    "cmyk": [
        "c": clamp01(Double(cmyk[0])) * 100.0,
        "m": clamp01(Double(cmyk[1])) * 100.0,
        "y": clamp01(Double(cmyk[2])) * 100.0,
        "k": clamp01(Double(cmyk[3])) * 100.0
    ],
    "outputLab": outputLab,
    "inputRgb": inputRgb,
    "outputRgb": outputRgb,
    "profilePath": payload.profilePath
]

let out = try JSONSerialization.data(withJSONObject: result, options: [.sortedKeys])
FileHandle.standardOutput.write(out)
