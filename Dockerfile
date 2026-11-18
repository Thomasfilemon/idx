FROM rust:1.100-bookworm AS build
WORKDIR /build
COPY Cargo.toml Cargo.lock ./
COPY src ./src
COPY data ./data
RUN cargo build --locked --release --bin idx-api

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --uid 10001 --create-home idx
COPY --from=build /build/target/release/idx-api /usr/local/bin/idx-api
ENV HOME=/home/idx IDX_API_BIND=0.0.0.0:8000
USER idx
EXPOSE 8000
ENTRYPOINT ["idx-api"]
