import { describe, expect, it } from "vitest";
import {
  compileHotelTemplate,
  compileRestockTemplate,
  compileWatchTemplate,
  isWatchTemplateId,
  readWatchTemplateValues,
  type WatchTemplateValues,
} from "@/lib/worker-template-compiler";

/**
 * What each template's answers compile to.
 *
 * **The Japanese wording is pinned to the character** where it was evaluated
 * against the model (the hotel date / room / room + price conditions and the
 * restock variant + no-pre-order condition, with their instructions): a change
 * to any of it is a change to what was measured, and should fail here first.
 */

const TODAY = { year: 2027, month: 4, day: 20 };
const JA = { language: "ja", today: TODAY };

function values(overrides: Partial<WatchTemplateValues> = {}): WatchTemplateValues {
  return {
    websiteUrl: "https://hotel.example/search?date=2027-05-02",
    name: "",
    notes: "",
    stayDate: "2027-05-02",
    room: "",
    maxPrice: "",
    product: "",
    variant: "",
    includePreorder: "",
    ...overrides,
  };
}

const HOTEL_BASE =
  "このページは、ホテルの空室照会ページです。5月2日の空室状況を確認してください。新たに予約可能になった部屋タイプやプラン、料金、残室数を簡潔に報告してください。満室になった、料金が変わったなどの変化は分けて書いてください。5月2日以外の日付の変化は、5月2日の変化と混同しないでください。";
const HOTEL_ROOM = "希望の部屋タイプ: ツイン・禁煙。該当するかどうかを明記してください。";
const HOTEL_PRICE = "料金上限: 20,000円。料金が分かる場合は上限以下かどうかを明記してください。";

const RESTOCK_BASE =
  "このページは「商品A」の商品ページです。在庫状況と購入可否の変化を、価格とあわせて簡潔に報告してください。「在庫あり」「カートに入れる」「購入する」などは購入可能の強い手がかりです。「近日再入荷予定」「再入荷通知を受け取る」だけの場合は、購入可能とは扱わないでください。";
const RESTOCK_VARIANT = "対象のバリエーション: ブラック M。他の色やサイズの在庫と区別してください。";
const RESTOCK_NO_PREORDER = "予約販売・予約注文は購入可能に含めません。";

function compiled(result: ReturnType<typeof compileHotelTemplate>) {
  if (!result.ok) {
    throw new Error(`expected a worker, got ${JSON.stringify(result.errors)}`);
  }
  return result.worker;
}

describe("the template allowlist", () => {
  it("knows exactly the two templates", () => {
    expect(isWatchTemplateId("hotel-availability")).toBe(true);
    expect(isWatchTemplateId("product-restock")).toBe(true);
    expect(isWatchTemplateId("price-drop")).toBe(false);
    expect(isWatchTemplateId("Hotel-Availability")).toBe(false);
    expect(isWatchTemplateId("")).toBe(false);
  });
});

describe("a hotel vacancy", () => {
  it("1: compiles a date alone", () => {
    expect(compiled(compileHotelTemplate(values(), JA))).toEqual({
      templateId: "hotel-availability",
      kind: "website",
      websiteUrl: "https://hotel.example/search?date=2027-05-02",
      name: "5月2日のホテル空室をチェック",
      prompt: HOTEL_BASE,
      targetCondition: "5月2日に宿泊できる部屋またはプランが新たに予約可能になったら通知する。",
    });
  });

  it("2: compiles a date and a room, as evaluated", () => {
    const worker = compiled(compileHotelTemplate(values({ room: "ツイン・禁煙" }), JA));

    expect(worker.prompt).toBe([HOTEL_BASE, HOTEL_ROOM].join("\n"));
    expect(worker.targetCondition).toBe(
      "5月2日にツイン・禁煙の部屋またはプランが新たに予約可能になったら通知する。それ以外の部屋タイプの空室は通知対象にしない。",
    );
  });

  it("3: compiles a date, a room and a price limit, as evaluated", () => {
    const worker = compiled(
      compileHotelTemplate(values({ room: "ツイン・禁煙", maxPrice: "20000" }), JA),
    );

    expect(worker.prompt).toBe([HOTEL_BASE, HOTEL_ROOM, HOTEL_PRICE].join("\n"));
    expect(worker.targetCondition).toBe(
      "5月2日にツイン・禁煙で20,000円以下の部屋またはプランが新たに予約可能になったら通知する。料金が表示されていない場合は、予約可能になった時点で通知する。",
    );
  });

  it("4: compiles a date and a price limit without a room", () => {
    const worker = compiled(compileHotelTemplate(values({ maxPrice: "15000" }), JA));

    expect(worker.prompt).toBe(
      [HOTEL_BASE, "料金上限: 15,000円。料金が分かる場合は上限以下かどうかを明記してください。"].join("\n"),
    );
    expect(worker.targetCondition).toBe(
      "5月2日に15,000円以下で宿泊できる部屋またはプランが新たに予約可能になったら通知する。料金が表示されていない場合は、予約可能になった時点で通知する。",
    );
  });

  it("5: keeps a name given, and adds notes to the instructions only", () => {
    const worker = compiled(
      compileHotelTemplate(values({ name: "GW旅行", notes: "朝食付きが望ましい" }), JA),
    );

    expect(worker.name).toBe("GW旅行");
    expect(worker.prompt).toBe([HOTEL_BASE, "補足: 朝食付きが望ましい"].join("\n"));
    expect(worker.targetCondition).not.toContain("朝食");
  });

  it("writes English for an English account", () => {
    const worker = compiled(
      compileHotelTemplate(values({ room: "Twin", maxPrice: "200" }), { language: "en", today: TODAY }),
    );

    expect(worker.name).toBe("Hotel vacancy on May 2");
    expect(worker.targetCondition).toBe(
      "Notify when a Twin room or plan for May 2 at 200 or less newly becomes bookable. If no price is shown, notify when it becomes bookable.",
    );
  });

  describe("6: what it refuses", () => {
    it.each([
      ["", "stayDate"],
      ["2027/05/02", "stayDate"],
      ["2027-02-30", "stayDate"],
      ["2027-13-01", "stayDate"],
      ["2027-04-19", "stayDate"],
    ])("a stay date of %o", (stayDate, field) => {
      const result = compileHotelTemplate(values({ stayDate }), JA);

      expect(result.ok).toBe(false);
      expect(result.ok ? {} : result.errors).toHaveProperty(field);
    });

    it("accepts today", () => {
      expect(compileHotelTemplate(values({ stayDate: "2027-04-20" }), JA).ok).toBe(true);
    });

    it.each(["0", "-1", "1.5", "20,000", "abc", "100000000"])("a price limit of %o", (maxPrice) => {
      const result = compileHotelTemplate(values({ maxPrice }), JA);

      expect(result.ok ? {} : result.errors).toHaveProperty("maxPrice");
    });

    it("accepts the price bounds", () => {
      expect(compileHotelTemplate(values({ maxPrice: "1" }), JA).ok).toBe(true);
      expect(compileHotelTemplate(values({ maxPrice: "99999999" }), JA).ok).toBe(true);
    });

    it("a room over 100 characters and notes over 500", () => {
      const result = compileHotelTemplate(
        values({ room: "x".repeat(101), notes: "x".repeat(501) }),
        JA,
      );

      expect(result.ok ? {} : Object.keys(result.errors).sort()).toEqual(["notes", "room"]);
    });

    it("accepts a room of 100 and notes of 500", () => {
      expect(
        compileHotelTemplate(values({ room: "x".repeat(100), notes: "x".repeat(500) }), JA).ok,
      ).toBe(true);
    });
  });
});

describe("a product restock", () => {
  const restock = (overrides: Partial<WatchTemplateValues> = {}) =>
    values({ websiteUrl: "https://shop.example/a", stayDate: "", product: "商品A", ...overrides });

  it("1: compiles the basic case, pre-orders counted", () => {
    const worker = compiled(compileRestockTemplate(restock({ includePreorder: "true" }), JA));

    expect(worker).toMatchObject({
      templateId: "product-restock",
      kind: "website",
      websiteUrl: "https://shop.example/a",
      name: "商品Aの再入荷をチェック",
    });
    expect(worker.prompt).toBe([RESTOCK_BASE, "予約販売・予約注文も購入可能に含めます。"].join("\n"));
    expect(worker.targetCondition).toBe(
      "この商品が売り切れ・在庫なしの状態から、実際に購入可能な状態になったら通知する。予約注文できる状態になった場合も通知する。",
    );
  });

  it("2: compiles a variant, pre-orders counted", () => {
    const worker = compiled(
      compileRestockTemplate(restock({ variant: "ブラック M", includePreorder: "true" }), JA),
    );

    expect(worker.targetCondition).toBe(
      "商品Aのブラック Mが実際に購入可能になったら通知する。他の色やサイズの在庫変化は通知対象にしない。予約注文できる状態になった場合も通知する。",
    );
  });

  it("3: compiles a variant without pre-orders, as evaluated", () => {
    const worker = compiled(compileRestockTemplate(restock({ variant: "ブラック M" }), JA));

    expect(worker.prompt).toBe([RESTOCK_BASE, RESTOCK_VARIANT, RESTOCK_NO_PREORDER].join("\n"));
    expect(worker.targetCondition).toBe(
      "商品Aのブラック Mが、予約販売ではなく通常購入できる状態になったら通知する。他の色やサイズ、予約受付の開始は通知対象にしない。",
    );
  });

  it("4: compiles no variant without pre-orders", () => {
    const worker = compiled(compileRestockTemplate(restock(), JA));

    expect(worker.prompt).toBe([RESTOCK_BASE, RESTOCK_NO_PREORDER].join("\n"));
    expect(worker.targetCondition).toBe(
      "商品Aが、予約販売ではなく通常購入できる状態になったら通知する。予約受付の開始だけでは通知しない。",
    );
  });

  it("5: leaves pre-orders out unless asked", () => {
    expect(compiled(compileRestockTemplate(restock(), JA)).prompt).toContain(RESTOCK_NO_PREORDER);
  });

  it("6: keeps a name given", () => {
    expect(compiled(compileRestockTemplate(restock({ name: "冬コート" }), JA)).name).toBe("冬コート");
  });

  it("writes English for an English account", () => {
    const worker = compiled(
      compileRestockTemplate(restock({ product: "Coat", variant: "Black M" }), { language: "en" }),
    );

    expect(worker.name).toBe("Restock check: Coat");
    expect(worker.targetCondition).toBe(
      "Notify when Black M of Coat can be bought normally, not as a pre-order. Do not notify about other colours or sizes, or about pre-orders opening.",
    );
  });

  describe("7: what it refuses", () => {
    it("a missing product name", () => {
      const result = compileRestockTemplate(restock({ product: "" }), JA);

      expect(result.ok ? {} : Object.keys(result.errors)).toEqual(["product"]);
    });

    it("a product over 80, a variant over 100 and notes over 500", () => {
      const result = compileRestockTemplate(
        restock({ product: "x".repeat(81), variant: "x".repeat(101), notes: "x".repeat(501) }),
        JA,
      );

      expect(result.ok ? {} : Object.keys(result.errors).sort()).toEqual([
        "notes",
        "product",
        "variant",
      ]);
    });

    it.each(["on", "false", "yes", "1"])("a pre-order answer of %o", (includePreorder) => {
      const result = compileRestockTemplate(restock({ includePreorder }), JA);

      expect(result.ok ? {} : result.errors).toHaveProperty("includePreorder");
    });
  });
});

describe("reading and dispatching", () => {
  it("reads only the answers, trimmed", () => {
    const data = new FormData();
    data.set("stayDate", " 2027-05-02 ");
    data.set("prompt", "not an answer");
    data.set("targetCondition", "not an answer");

    const read = readWatchTemplateValues(data);

    expect(read.stayDate).toBe("2027-05-02");
    expect(read).not.toHaveProperty("prompt");
    expect(read).not.toHaveProperty("targetCondition");
    expect(read.room).toBe("");
  });

  it("compiles each template by its own rules", () => {
    expect(compileWatchTemplate("hotel-availability", values(), JA).ok).toBe(true);
    expect(compileWatchTemplate("product-restock", values(), JA).ok).toBe(false);
  });
});
