fn reaches_zero(n: Int) -> Bool {
  n == 0 || reaches_zero(n - 1)
}

pub fn main() {
  reaches_zero(2)
}
