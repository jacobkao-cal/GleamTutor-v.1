import { gleamStringLiteral } from "./format";

describe("gleamStringLiteral", () => {
  it.each([
    ["Hello, Jacob", '"Hello, Jacob"'],
    ["", '""'],
    ['say "hi"', '"say \\"hi\\""'],
    ["back\\slash", '"back\\\\slash"'],
    ["one\ntwo", '"one\\ntwo"'],
    ["tab\there\r\f", '"tab\\there\\r\\f"'],
    ["bell\u0007", '"bell\\u{7}"'],
    ["héllo 🌟 日本", '"héllo 🌟 日本"'],
  ])("%j is shown as %s", (value, shown) => {
    expect(gleamStringLiteral(value)).toBe(shown);
  });
});
