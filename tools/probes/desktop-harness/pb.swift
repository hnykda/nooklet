// pb save <file> | pb restore <file> | pb text | pb count — snapshot the general pasteboard (all items, all types) so a
// verification that has to press Cmd+C/X leaves the owner's clipboard exactly as it was.
import AppKit
let pb = NSPasteboard.general
let a = CommandLine.arguments
switch a[1] {
case "save":
  var items: [[String: Data]] = []
  for it in pb.pasteboardItems ?? [] {
    var d: [String: Data] = [:]
    for t in it.types { if let data = it.data(forType: t) { d[t.rawValue] = data } }
    items.append(d)
  }
  let blob = try! PropertyListSerialization.data(fromPropertyList: ["count": pb.changeCount, "items": items], format: .binary, options: 0)
  try! blob.write(to: URL(fileURLWithPath: a[2]))
  print("saved \(items.count) items, changeCount \(pb.changeCount)")
case "restore":
  let plist = try! PropertyListSerialization.propertyList(from: Data(contentsOf: URL(fileURLWithPath: a[2])), format: nil) as! [String: Any]
  let items = plist["items"] as! [[String: Data]]
  pb.clearContents()
  let objs: [NSPasteboardItem] = items.map { d in
    let it = NSPasteboardItem()
    for (t, data) in d { it.setData(data, forType: NSPasteboard.PasteboardType(t)) }
    return it
  }
  if !objs.isEmpty { pb.writeObjects(objs) }
  print("restored \(objs.count) items")
case "text":
  print(pb.string(forType: .string) ?? "<no string>")
case "count":
  print(pb.changeCount)
default: break
}
