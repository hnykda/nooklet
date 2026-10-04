// Decodes every QR code in a PNG with Apple's own detector (Core Image, the same family of code
// the iOS Camera uses), and prints the payload. Settles "does the QR nooklet draws actually
// encode the pairing URL" (B-655) without trusting the encoder library.
//
//   swift tools/probes/qr-decode/decode.swift <file.png> [more.png ...]
//
// Inputs used: the Settings → Devices QR screenshotted by `e2e/tests/qr-pairing.spec.ts`
// (`pairing-qr.png` in its test-results dir), and a PNG of `nooklet pair`'s terminal QR.
import CoreImage
import Foundation

for path in CommandLine.arguments.dropFirst() {
  guard let image = CIImage(contentsOf: URL(fileURLWithPath: path)) else {
    print("\(path): cannot read image")
    exit(1)
  }
  let detector = CIDetector(
    ofType: CIDetectorTypeQRCode, context: nil,
    options: [CIDetectorAccuracy: CIDetectorAccuracyHigh])
  let found = (detector?.features(in: image) ?? []).compactMap { ($0 as? CIQRCodeFeature)?.messageString }
  if found.isEmpty {
    print("\(path): NO QR CODE FOUND")
    exit(2)
  }
  for message in found { print("\(path): \(message)") }
}
