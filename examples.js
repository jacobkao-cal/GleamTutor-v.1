const GT_EXAMPLES = [
{ group: 'Basics', id: 'hello', title: 'Hello world', code:
`import gleam/io

pub fn main() {
  io.println("Hello, Joe!")
  io.println("Hello, Mike!")
}
` },
{ group: 'Basics', id: 'assignments', title: 'Assignments and shadowing', code:
`import gleam/io

pub fn main() {
  let x = "Original"
  io.println(x)

  // Assign \`y\` to the value of \`x\`
  let y = x
  io.println(y)

  // Assign \`x\` to a new value. This shadows the old \`x\`.
  let x = "New"
  io.println(x)

  // \`y\` still refers to the original value
  io.println(y)
}
` },
{ group: 'Basics', id: 'lists', title: 'Lists share their tails', code:
`import gleam/io
import gleam/string

pub fn main() {
  let ints = [1, 2, 3]
  io.println(string.inspect(ints))

  // Prepending builds a new list that points at the old one.
  // Watch the arrow: nothing is copied.
  let more = [-1, 0, ..ints]
  io.println(string.inspect(more))

  // The original list is unchanged
  io.println(string.inspect(ints))
}
` },
{ group: 'Functions', id: 'functions', title: 'Functions', code:
`import gleam/int
import gleam/io

pub fn main() {
  let total = add(2, 3)
  let doubled = double(total)
  io.println(int.to_string(doubled))
}

fn add(x: Int, y: Int) -> Int {
  x + y
}

fn double(a: Int) -> Int {
  multiply(a, 2)
}

fn multiply(a: Int, b: Int) -> Int {
  a * b
}
` },
{ group: 'Functions', id: 'hof', title: 'Higher order functions and captures', code:
`import gleam/int
import gleam/io

pub fn main() {
  let add_one = fn(x) { x + 1 }
  let result = twice(add_one, 10)
  io.println(int.to_string(result))

  // A function capture is shorthand for an anonymous function
  let add_ten = add(10, _)
  io.println(int.to_string(twice(add_ten, 1)))
}

fn twice(f: fn(Int) -> Int, x: Int) -> Int {
  f(f(x))
}

fn add(a: Int, b: Int) -> Int {
  a + b
}
` },
{ group: 'Functions', id: 'pipelines', title: 'Pipelines', code:
`import gleam/int
import gleam/io
import gleam/list

pub fn main() {
  [1, 2, 3, 4, 5]
  |> list.map(fn(x) { x * x })
  |> list.filter(fn(x) { x % 2 == 1 })
  |> list.fold(0, fn(acc, x) { acc + x })
  |> int.to_string
  |> io.println
}
` },
{ group: 'Functions', id: 'labelled', title: 'Labelled arguments', code:
`import gleam/io

pub fn main() {
  // Labelled arguments can be given in any order
  let a = calculate(1, add: 2, multiply: 3)
  let b = calculate(1, multiply: 3, add: 2)
  io.println(describe(a == b))
}

fn calculate(value: Int, add addend: Int, multiply multiplier: Int) -> Int {
  value * multiplier + addend
}

fn describe(same: Bool) -> String {
  case same {
    True -> "Same answer either way"
    False -> "Different answers"
  }
}
` },
{ group: 'Flow control', id: 'recursion', title: 'Recursion: factorial', code:
`import gleam/int
import gleam/io

pub fn main() {
  let result = factorial(4)
  io.println(int.to_string(result))
}

pub fn factorial(n: Int) -> Int {
  case n {
    0 -> 1
    _ -> n * factorial(n - 1)
  }
}
` },
{ group: 'Flow control', id: 'list-recursion', title: 'List recursion', code:
`import gleam/int
import gleam/io

pub fn main() {
  let total = sum_list([18, 56, 35])
  io.println(int.to_string(total))
}

fn sum_list(list: List(Int)) -> Int {
  case list {
    [] -> 0
    [first, ..rest] -> first + sum_list(rest)
  }
}
` },
{ group: 'Flow control', id: 'tail-calls', title: 'Tail calls with an accumulator', code:
`import gleam/int
import gleam/io

// The real Gleam runtime reuses the stack frame for a tail call.
// The tutor still draws each frame so you can watch \`acc\` grow.
pub fn main() {
  io.println(int.to_string(factorial(5)))
}

pub fn factorial(n: Int) -> Int {
  factorial_loop(n, 1)
}

fn factorial_loop(n: Int, acc: Int) -> Int {
  case n {
    0 -> acc
    _ -> factorial_loop(n - 1, acc * n)
  }
}
` },
{ group: 'Flow control', id: 'partitions', title: 'Tree recursion: count partitions', code:
`import gleam/int
import gleam/io

/// Ways to write n as a sum of parts no larger than m (CS 61A)
pub fn main() {
  io.println(int.to_string(count_partitions(5, 3)))
}

fn count_partitions(n: Int, m: Int) -> Int {
  case n, m {
    0, _ -> 1
    _, _ if n < 0 -> 0
    _, 0 -> 0
    _, _ -> count_partitions(n - m, m) + count_partitions(n, m - 1)
  }
}
` },
{ group: 'Flow control', id: 'string-patterns', title: 'String patterns and guards', code:
`import gleam/io

pub fn main() {
  io.println(greet("Hello, Joe"))
  io.println(greet("Hi there"))
  io.println(size(7))
  io.println(size(120))
}

fn greet(message: String) -> String {
  case message {
    "Hello, " <> name -> "Welcome back, " <> name
    _ -> "I don't know you"
  }
}

fn size(n: Int) -> String {
  case n {
    x if x < 10 -> "small"
    x if x < 100 -> "medium"
    _ -> "large"
  }
}
` },
{ group: 'Data types', id: 'tuples', title: 'Tuples', code:
`import gleam/io
import gleam/string

pub fn main() {
  let triple = #(1, 2.2, "three")
  io.println(string.inspect(triple))

  let #(a, _, _) = triple
  io.println(string.inspect(a))
  io.println(triple.2)
}
` },
{ group: 'Data types', id: 'custom-types', title: 'Custom types', code:
`import gleam/float
import gleam/io

pub type Shape {
  Circle(radius: Float)
  Rectangle(width: Float, height: Float)
}

pub fn main() {
  let shapes = [Circle(1.0), Rectangle(width: 2.0, height: 3.0)]
  let total = total_area(shapes, 0.0)
  io.println("Total area: " <> float.to_string(total))
}

fn area(shape: Shape) -> Float {
  case shape {
    Circle(radius: r) -> 3.0 *. r *. r
    Rectangle(width: w, height: h) -> w *. h
  }
}

fn total_area(shapes: List(Shape), acc: Float) -> Float {
  case shapes {
    [] -> acc
    [first, ..rest] -> total_area(rest, acc +. area(first))
  }
}
` },
{ group: 'Data types', id: 'records', title: 'Records and record updates', code:
`import gleam/io
import gleam/string

pub type Teacher {
  Teacher(name: String, subject: String, floor: Int, room: Int)
}

pub fn main() {
  let teacher1 = Teacher(name: "Mr Dodd", subject: "ICT", floor: 2, room: 2)

  // Record update makes a new record; teacher1 is untouched
  let teacher2 = Teacher(..teacher1, subject: "PE", room: 6)

  io.println(teacher1.subject)
  io.println(string.inspect(teacher2))
}
` },
{ group: 'Data types', id: 'results', title: 'Results', code:
`import gleam/int
import gleam/io

pub type PurchaseError {
  NotEnoughMoney(required: Int)
  NotLuckyEnough
}

pub fn main() {
  report(buy_pastry(10))
  report(buy_pastry(1))
}

fn buy_pastry(money: Int) -> Result(Int, PurchaseError) {
  case money >= 5 {
    True -> Ok(money - 5)
    False -> Error(NotEnoughMoney(required: 5))
  }
}

fn report(result: Result(Int, PurchaseError)) -> Nil {
  case result {
    Ok(change) -> io.println("Bought a pastry! Change: " <> int.to_string(change))
    Error(NotEnoughMoney(required: r)) -> io.println("Need " <> int.to_string(r) <> " coins")
    Error(NotLuckyEnough) -> io.println("Unlucky!")
  }
}
` },
{ group: 'Standard library', id: 'dict', title: 'Dict module', code:
`import gleam/dict
import gleam/io
import gleam/string

pub fn main() {
  let scores = dict.from_list([#("Ada", 13), #("Grace", 7)])
  let scores = dict.insert(scores, "Alan", 9)
  io.println(string.inspect(dict.get(scores, "Ada")))
  io.println(string.inspect(dict.get(scores, "Joe")))
  io.println(string.inspect(dict.size(scores)))
}
` },
{ group: 'Standard library', id: 'option', title: 'Option module', code:
`import gleam/io
import gleam/option.{type Option, None, Some}

pub fn main() {
  io.println(greeting(Some("Ada")))
  io.println(greeting(None))
}

fn greeting(name: Option(String)) -> String {
  let name = option.unwrap(name, "stranger")
  "Hello, " <> name
}
` },
{ group: 'Advanced features', id: 'use', title: 'use with result.try', code:
`import gleam/int
import gleam/io
import gleam/result

pub fn main() {
  io.println(describe("4", "2"))
  io.println(describe("4", "zero"))
}

fn describe(a: String, b: String) -> String {
  case add_strings(a, b) {
    Ok(n) -> "Sum: " <> int.to_string(n)
    Error(_) -> "Could not parse a number"
  }
}

fn add_strings(a: String, b: String) -> Result(Int, Nil) {
  use x <- result.try(int.parse(a))
  use y <- result.try(int.parse(b))
  Ok(x + y)
}
` },
{ group: 'Advanced features', id: 'let-assert', title: 'let assert (crashes on purpose)', code:
`import gleam/io
import gleam/string

pub fn main() {
  io.println(first_letter("gleam"))
  io.println(first_letter(""))
}

fn first_letter(word: String) -> String {
  let assert [letter, ..] = string.to_graphemes(word)
  letter
}
` },
];
if (typeof module !== 'undefined') module.exports = GT_EXAMPLES;
// ES module export so the Vite app imports this file directly (types: examples.d.ts).
export { GT_EXAMPLES };
