import { describe, expect, it } from "vitest";
import { isPrivateModelEndpoint, isPrivateOrLoopbackHost } from "./private-endpoint.js";

describe("isPrivateOrLoopbackHost", () => {
  it.each([
    "localhost",
    "127.0.0.1",
    "127.53.0.9",
    "10.0.0.5",
    "172.16.4.4",
    "172.31.255.255",
    "192.168.1.100",
    "169.254.1.1",
    "100.64.0.1",
    "::1",
    "fe80::1",
    "fc00::1",
    "fd00::abcd",
    "::ffff:127.0.0.1",
    "::ffff:10.1.2.3",
  ])("treats %s as private/loopback", (host) => {
    expect(isPrivateOrLoopbackHost(host)).toBe(true);
  });

  it.each([
    "example.com",
    "api.openai.com",
    "8.8.8.8",
    "1.1.1.1",
    "172.32.0.1", // just outside 172.16.0.0/12
    "2001:4860:4860::8888",
  ])("treats %s as not private/loopback", (host) => {
    expect(isPrivateOrLoopbackHost(host)).toBe(false);
  });

  it("strips IPv6 brackets", () => {
    expect(isPrivateOrLoopbackHost("[::1]")).toBe(true);
  });
});

describe("isPrivateModelEndpoint", () => {
  it("returns true for a loopback baseUrl", () => {
    expect(isPrivateModelEndpoint("http://127.0.0.1:8000/v1")).toBe(true);
  });

  it("returns true for a LAN baseUrl", () => {
    expect(isPrivateModelEndpoint("http://192.168.100.11:8000/v1")).toBe(true);
  });

  it("returns false for a public baseUrl", () => {
    expect(isPrivateModelEndpoint("https://api.kilo.ai/v1")).toBe(false);
  });

  it("returns false for undefined", () => {
    expect(isPrivateModelEndpoint(undefined)).toBe(false);
  });

  it("returns false for an unparseable baseUrl", () => {
    expect(isPrivateModelEndpoint("not a url")).toBe(false);
  });
});
