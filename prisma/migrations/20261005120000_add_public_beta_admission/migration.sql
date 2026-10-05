-- CreateTable
CREATE TABLE "PublicBetaAdmission" (
    "userId" TEXT NOT NULL,
    "admittedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PublicBetaAdmission_pkey" PRIMARY KEY ("userId")
);
