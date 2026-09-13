import CoreGraphics
let k = CGEventSource.secondsSinceLastEventType(.combinedSessionState, eventType: .keyDown)
let m = CGEventSource.secondsSinceLastEventType(.combinedSessionState, eventType: .mouseMoved)
let c = CGEventSource.secondsSinceLastEventType(.combinedSessionState, eventType: .leftMouseDown)
print(Int(min(k, m, c)))
