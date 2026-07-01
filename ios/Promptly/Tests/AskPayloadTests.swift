import Foundation

// Standalone tests for the pure Phase D ask-back model + answer builder.
// Compile with AskPayload.swift and run natively (see ios/Promptly/Tests/run.sh).

var failures = 0
var checks = 0
func check(_ cond: Bool, _ msg: String) {
    checks += 1
    if cond { print("ok   - \(msg)") } else { failures += 1; print("FAIL - \(msg)") }
}
func decodeAsk(_ json: String) -> AskPayload? {
    try? JSONDecoder().decode(AskPayload.self, from: Data(json.utf8))
}

@main
struct AskPayloadTestMain {
static func main() {

    // Full decode
    let full = decodeAsk("""
    {"ask_id":"a1","prompt":"Got a screenshot?","answer_kinds":["text","image"],"optional":true,"context":"hero"}
    """)
    check(full != nil, "decodes a well-formed ask")
    check(full?.askId == "a1", "askId parsed")
    check(full?.answerKinds == [.text, .image], "answer_kinds parsed in order")
    check(full?.accepts(.image) == true && full?.accepts(.clip) == false, "accepts() reflects kinds")
    check(full?.isRenderable == true, "well-formed ask is renderable")

    // Unknown answer_kind ignored (forward-compat), not a decode failure
    let fwd = decodeAsk("""
    {"ask_id":"a2","prompt":"p","answer_kinds":["image","hologram","choice"]}
    """)
    check(fwd != nil, "decodes despite an unknown answer_kind")
    check(fwd?.answerKinds == [.image, .choice], "unknown kind filtered out")
    check(fwd?.optional == true, "optional defaults true when absent")

    // Empty/missing kinds → not renderable
    let empty = decodeAsk(#"{"ask_id":"a3","prompt":"p","answer_kinds":[]}"#)
    check(empty?.isRenderable == false, "no usable kinds → not renderable")
    let noId = decodeAsk(#"{"ask_id":"","prompt":"p","answer_kinds":["text"]}"#)
    check(noId?.isRenderable == false, "empty ask_id → not renderable")
    // #8: a MISSING ask_id must DECODE (not throw) — a throw would fail the whole
    // poll row decode and freeze the bar. It just isn't renderable.
    let missingId = decodeAsk(#"{"prompt":"p","answer_kinds":["text"]}"#)
    check(missingId != nil, "missing ask_id decodes (does not throw)")
    check(missingId?.isRenderable == false, "missing ask_id → not renderable")
    // context sent as an object (worker slug) decodes safely to nil, no crash.
    let objCtx = decodeAsk(#"{"ask_id":"a5","prompt":"p","answer_kinds":["text"],"context":{"reason":"x"}}"#)
    check(objCtx != nil && objCtx?.context == nil, "object context decodes to nil safely")

    // Choices: bare strings and objects both decode
    let ch = decodeAsk("""
    {"ask_id":"a4","prompt":"pick","answer_kinds":["choice"],"choices":["moody",{"value":"bright","label":"Add a brighter clip"}]}
    """)
    check(ch?.choices?.count == 2, "two choices decoded")
    check(ch?.choices?[0].value == "moody" && ch?.choices?[0].label == "moody", "bare-string choice: value==label")
    check(ch?.choices?[1].value == "bright" && ch?.choices?[1].label == "Add a brighter clip", "object choice: value + label")

    // AskAnswer builder + request body
    var a = AskAnswer(); a.text = "  it's a fitness app  "
    check(a.hasContent, "text answer has content")
    let body = a.requestBody(originalJobId: "job1", askId: "a1")
    check(body.answer == "it's a fitness app", "text trimmed into answer")
    check(body.skip == nil && body.answer_image_key == nil, "unused fields omitted")

    let img = AskAnswer(imageKey: "uploads/x.jpg").requestBody(originalJobId: "j", askId: "a1")
    check(img.answer_image_key == "uploads/x.jpg" && img.answer == nil, "image key in body, no text")

    let skip = AskAnswer.skipped
    check(skip.hasContent, "skip counts as content")
    check(skip.requestBody(originalJobId: "j", askId: "a1").skip == true, "skip serializes as true")

    let emptyAns = AskAnswer()
    check(!emptyAns.hasContent, "empty answer has no content (Send disabled)")

    // Request body encodes with nils omitted
    if let data = try? JSONEncoder().encode(img),
       let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
        check(obj["answer_image_key"] != nil, "encoded body includes image key")
        check(obj["answer"] == nil && obj["skip"] == nil, "encoded body omits nil fields")
    } else {
        check(false, "request body encodes to JSON")
    }

    print("\n\(checks - failures)/\(checks) checks passed")
    exit(failures == 0 ? 0 : 1)
}
}
