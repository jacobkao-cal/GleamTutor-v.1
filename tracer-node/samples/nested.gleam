fn sq(x: Int) -> Int {
  x * x
}

pub fn main() {
  let r = sq(sq(2)) + 1
  let d = r / 0
  let q = -7 % 3
  r + d + q
}
