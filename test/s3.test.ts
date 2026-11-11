import { describe, expect, it } from "vitest";
import { buildS3PutRequest } from "../src/s3";

describe("buildS3PutRequest", () => {
  // Expected values generated with botocore's S3SigV4Auth for the same inputs.
  it("produces the same SigV4 signature as the AWS SDK", async () => {
    const request = await buildS3PutRequest(
      {
        endpoint: "https://s3.test",
        bucket: "my-bucket",
        region: "us-east-1",
        accessKeyId: "AKIDEXAMPLE",
        secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
      },
      "logs/2026/a b*.json",
      '{"hello":"world"}',
      "application/json",
      new Date("2026-11-11T08:09:10Z")
    );

    expect(request.method).toBe("PUT");
    expect(request.url).toBe("https://s3.test/my-bucket/logs/2026/a%20b%2A.json");
    expect(request.headers.get("x-amz-date")).toBe("20261111T080910Z");
    expect(request.headers.get("x-amz-content-sha256")).toBe(
      "93a23971a914e5eacbf0a8d25154cda309c3c1c72fbb9914d47c60f3cb681588"
    );
    expect(request.headers.get("Authorization")).toBe(
      "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20261111/us-east-1/s3/aws4_request, " +
        "SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date, " +
        "Signature=8213b9d8703ab4288f36a805dd2388a6eb973f417b9b0badf73e6686f947d4d2"
    );
  });
});
