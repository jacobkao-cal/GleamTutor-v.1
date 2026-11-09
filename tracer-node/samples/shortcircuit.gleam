fn is_pos(n: Int) -> Bool {
  n > 0
}

pub fn main() {
  let a = -3
  let ok = is_pos(a) && is_pos(10)
  ok
}
